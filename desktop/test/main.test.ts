import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../server/src/app.js";
import { addPerson } from "../../server/src/auth.js";
import { loadConfig } from "../../server/src/config.js";
import { Store } from "../../server/src/store.js";
import { ApiClient, ApiError, mimeFor, type TokenStore } from "../src/main/api.js";
import { createHandlers } from "../src/main/handlers.js";
import { Settings } from "../src/main/settings.js";
import { FileTokenStore, type Crypto } from "../src/main/tokenStore.js";

const memoryTokens = (): TokenStore & { value: string | null } => ({
  value: null,
  get() {
    return this.value;
  },
  set(t) {
    this.value = t;
  },
});

describe("desktop main process against the real backend (mock vendors)", () => {
  let close: () => void;
  let base: string;
  let store: Store;

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cloneme-desktop-"));
    const config = loadConfig({ MOCK_MODE: "true", DATA_DIR: dir, OWNER_NAME: "Sam Rivera", OWNER_INVITE_CODE: "OWNR-TEST-CODE", SESSION_SECRET: "s".repeat(40) });
    store = new Store(dir, config.ownerName);
    const ctx = createApp({ config, store });
    const server = ctx.app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  const make = (onUnauthorized = () => {}) => {
    const tokens = memoryTokens();
    const api = new ApiClient(base, tokens, onUnauthorized);
    const handlers = createHandlers({ api, version: "1.2.3", settings: new Settings(mkdtempSync(path.join(tmpdir(), "set-"))), pickFiles: async () => [] });
    return { api, tokens, handlers };
  };

  it("signs in with an invite code, remembers the token, and shows friendly errors", async () => {
    const { handlers, tokens } = make();
    await expect(handlers.signIn("WRONG-CODE-1234")).rejects.toThrow(/invite code didn't work/);
    expect(tokens.value).toBeNull();
    const { code } = addPerson(store, { name: "Alex Kim", role: "friend" });
    const person = await handlers.signIn(code);
    expect(person).toMatchObject({ name: "Alex Kim", ownerName: "Sam Rivera", aiBanner: true });
    expect(tokens.value).toBeTruthy();
    expect(await handlers.getState()).toMatchObject({ person: { name: "Alex Kim" }, version: "1.2.3" });
    await handlers.signOut();
    expect((await handlers.getState()).person).toBeNull();
  });

  it("runs a call lifecycle: start, text fallback, end", async () => {
    const { handlers } = make();
    await handlers.signIn(addPerson(store, { name: "Mom", role: "family" }).code);
    const session = await handlers.startSession();
    expect(session).toMatchObject({ mock: true, banner: null });
    expect(session.greeting).toContain("Mom");
    expect((await handlers.sendText(session.sessionId, "hello")).reply).toBeTruthy();
    await handlers.endSession(session.sessionId);
    await expect(handlers.sendText(session.sessionId, "hello")).rejects.toThrow();
  });

  it("forbids owner calls for non-owners and reports revoked access", async () => {
    let signedOut = 0;
    const { handlers, api } = make(() => signedOut++);
    const { person, code } = addPerson(store, { name: "Temp", role: "friend" });
    await handlers.signIn(code);
    await expect(handlers.listPeople()).rejects.toBeInstanceOf(ApiError);

    const owner = make();
    await owner.handlers.signIn("OWNR-TEST-CODE");
    await owner.handlers.revokePerson(person.id);
    await expect(api.me()).rejects.toThrow(/access has ended/);
    expect(signedOut).toBe(1);
    expect(api.signedIn).toBe(false);
  });

  it("owner mode: profile, people, uploads, training, vendor status", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "uploads-"));
    const notes = path.join(dir, "notes.txt");
    writeFileSync(notes, "I grew up in Portland and I love hiking.\nHonestly it's been a great year, you know?");
    const { api } = make();
    const handlers = createHandlers({ api, version: "x", settings: new Settings(mkdtempSync(path.join(tmpdir(), "set-"))), pickFiles: async () => [notes, path.join(dir, "missing.txt")] });
    await handlers.signIn("OWNR-TEST-CODE");

    const saved = await handlers.saveProfile({ basics: "Designer.", avoidTopics: ["politics"] });
    expect(saved.avoidTopics).toEqual(["politics"]);
    expect((await handlers.getProfile()).basics).toBe("Designer.");

    const added = await handlers.addPerson({ name: "Dana", role: "family", relationship: "sister" });
    expect(added.inviteCode).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){2}$/);
    expect((await handlers.setPersonBanner(added.person.id, true)).aiBanner).toBe(true);
    expect((await handlers.listPeople()).people.map((p) => p.name)).toContain("Dana");

    const up = await handlers.pickAndUpload("training");
    expect(up.uploaded).toHaveLength(1);
    expect(up.failed).toHaveLength(1);
    expect((await handlers.listMedia()).media[0]).toMatchObject({ filename: "notes.txt", purpose: "training" });

    expect((await handlers.runTraining()).started).toBe(true);
    for (let i = 0; i < 50 && (await handlers.listJobs()).jobs[0]?.status === "running"; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await handlers.listJobs()).jobs[0]!.status).toBe("done");
    expect((await handlers.getStyle()).style?.sampleCount).toBeGreaterThan(0);
    const facts = (await handlers.getFacts()).facts;
    expect(facts.length).toBeGreaterThan(0);
    expect((await handlers.setFactStatus(facts[0]!.id, "approved")).status).toBe("approved");

    const vendors = await handlers.getVendors(true);
    expect(vendors.mode.tavus).toBe("mock");
    expect(vendors.readyForCalls).toBe(false);
  });

  it("reports an unreachable server clearly", async () => {
    const api = new ApiClient("http://127.0.0.1:1", memoryTokens());
    await expect(api.redeem("ABCD-EFGH-JKLM")).rejects.toThrow(/Cannot reach the server/);
  });
});

describe("token store", () => {
  const crypto = (available = true): Crypto => ({
    available: () => available,
    encrypt: (s) => Buffer.from(`enc:${s}`),
    decrypt: (b) => {
      const text = b.toString();
      if (!text.startsWith("enc:")) throw new Error("bad");
      return text.slice(4);
    },
  });

  it("round-trips an encrypted token across restarts and clears on sign-out", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tok-"));
    new FileTokenStore(dir, crypto()).set("abc.def");
    const reopened = new FileTokenStore(dir, crypto());
    expect(reopened.get()).toBe("abc.def");
    reopened.set(null);
    expect(new FileTokenStore(dir, crypto()).get()).toBeNull();
  });

  it("never writes plaintext when OS encryption is unavailable", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tok-"));
    const store = new FileTokenStore(dir, crypto(false));
    store.set("secret");
    expect(store.get()).toBe("secret");
    expect(new FileTokenStore(dir, crypto(false)).get()).toBeNull();
  });

  it("discards a corrupt token file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tok-"));
    writeFileSync(path.join(dir, "session.bin"), "garbage");
    expect(new FileTokenStore(dir, crypto()).get()).toBeNull();
  });

  it("maps upload mime types", () => {
    expect(mimeFor("a.WAV")).toBe("audio/wav");
    expect(mimeFor("a.unknown")).toBe("application/octet-stream");
  });
});
