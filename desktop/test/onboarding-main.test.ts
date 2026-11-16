import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../server/src/app.js";
import { loadConfig } from "../../server/src/config.js";
import { Store } from "../../server/src/store.js";
import { ApiClient, type TokenStore } from "../src/main/api.js";
import { createHandlers } from "../src/main/handlers.js";
import { mediaDuration } from "../src/main/mediaDuration.js";
import { Settings } from "../src/main/settings.js";
import { encodeWav } from "../src/shared/audioAnalysis.js";

const SETUP_TOKEN = "setup-token-for-tests-1234";

const memoryTokens = (): TokenStore & { value: string | null } => ({
  value: null,
  get() {
    return this.value;
  },
  set(t) {
    this.value = t;
  },
});

/** Vendor hosts answer from a table; everything else (the local backend) goes through the real fetch. */
function vendorFetch(accept: Record<string, string>) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (/^http:\/\/127\.0\.0\.1/.test(url)) return fetch(input, init);
    calls.push(url);
    const headers = new Headers(init?.headers);
    const sent = headers.get("x-api-key") ?? headers.get("xi-api-key") ?? headers.get("authorization")?.replace(/^(Bearer|Token) /, "");
    const ok = Object.values(accept).includes(sent ?? "");
    return new Response(JSON.stringify(url.includes("elevenlabs") ? { can_use_professional_voice_cloning: true } : {}), { status: ok ? 200 : 401 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("onboarding in the desktop main process", () => {
  let close: () => void;
  let base: string;
  let store: Store;

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cloneme-onb-"));
    const config = loadConfig({ MOCK_MODE: "true", DATA_DIR: dir, SETUP_TOKEN, PERSISTENT_STORAGE: "true", PUBLIC_BASE_URL: "http://127.0.0.1:1" });
    store = new Store(dir, config.ownerName);
    const ctx = createApp({ config, store });
    const server = ctx.app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  const make = (accept: Record<string, string> = {}) => {
    const tokens = memoryTokens();
    const settingsDir = mkdtempSync(path.join(tmpdir(), "set-"));
    const api = new ApiClient("http://default.invalid", tokens);
    const fetchStub = vendorFetch(accept);
    const settings = new Settings(settingsDir);
    const handlers = createHandlers({ api, version: "1", settings, fetchImpl: fetchStub.impl, pickFiles: async () => [] });
    return { api, tokens, settings, handlers, fetchStub, settingsDir };
  };

  it("checks a server's health in plain language", async () => {
    const { handlers } = make();
    expect(await handlers.checkServer(base)).toMatchObject({ reachable: true, isCloneme: true, claimed: false, claimable: true, persistentStorage: true, https: true });
    expect((await handlers.checkServer("")).message).toMatch(/does not look right/);
    expect((await handlers.checkServer("http://127.0.0.1:9")).reachable).toBe(false);
  });

  it("only opens https links", async () => {
    const opened: string[] = [];
    const api = new ApiClient(base, memoryTokens());
    const handlers = createHandlers({ api, version: "1", settings: new Settings(mkdtempSync(path.join(tmpdir(), "s-"))), openExternal: (u) => void opened.push(u), pickFiles: async () => [] });
    await handlers.openExternal("https://app.tavus.io/");
    await expect(handlers.openExternal("file:///etc/passwd")).rejects.toThrow(/secure links/);
    await expect(handlers.openExternal("javascript:alert(1)")).rejects.toThrow();
    expect(opened).toEqual(["https://app.tavus.io/"]);
  });

  it("tests keys before the server exists, holds them in memory, and delivers them when the server is claimed", async () => {
    const { handlers, settings, tokens, settingsDir } = make({ t: "tavus-good-key", e: "eleven-good-key", d: "deepgram-good-key", l: "llm-good-key" });
    await handlers.saveLocalWizard({ consentAccepted: true, consentName: "Sam Rivera", currentStep: "keys" });

    const first = await handlers.submitKeys({ tavus: "tavus-good-key", elevenlabs: "wrong-eleven-key" });
    expect(first.stagedOnly).toBe(true);
    expect(first.results.tavus!.ok).toBe(true);
    expect(first.results.elevenlabs).toMatchObject({ ok: false });
    expect(first.results.elevenlabs!.message).toMatch(/rejected this key/);
    await handlers.submitKeys({ elevenlabs: "eleven-good-key", deepgram: "deepgram-good-key", llm: { apiKey: "llm-good-key", model: "gpt-4o-mini" } });

    const before = await handlers.getKeysStatus();
    expect(before.connected).toBe(false);
    expect(Object.values(before.vendors).every((v) => v.staged && !v.saved)).toBe(true);
    expect(before.llm.model).toBe("gpt-4o-mini");
    // Nothing secret is written next to the app's non-secret settings.
    expect(JSON.stringify(settings.wizard)).not.toMatch(/good-key/);
    expect(readFileSync(path.join(settingsDir, "settings.json"), "utf8")).not.toMatch(/good-key/);

    await expect(handlers.connectServer({ serverUrl: base, setupToken: "not-the-right-token-xx", ownerName: "Sam Rivera" })).rejects.toThrow(/setup token is not right/);
    expect(tokens.value).toBeNull();

    const connected = await handlers.connectServer({ serverUrl: base, setupToken: SETUP_TOKEN, ownerName: "Sam Rivera" });
    expect(connected.person).toMatchObject({ role: "owner", name: "Sam Rivera" });
    expect(connected.ownerCode).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){2}$/);
    expect(Object.keys(connected.keyResults).sort()).toEqual(["deepgram", "elevenlabs", "llm", "tavus"]);
    expect(settings.serverUrl).toBe(base);

    const after = await handlers.getKeysStatus();
    expect(after.connected).toBe(true);
    for (const v of Object.values(after.vendors)) expect(v).toMatchObject({ saved: true, staged: false });
    const onboarding = await handlers.getOnboarding();
    expect(onboarding?.state.consentName).toBe("Sam Rivera");
    expect(onboarding?.state.consentAcceptedAt).toBeTruthy();
    expect(onboarding?.serverUrl).toBeDefined();

    expect(JSON.stringify(await handlers.getKeysStatus())).not.toMatch(/good-key/);
    expect(JSON.stringify(onboarding)).not.toMatch(/good-key/);
  });

  it("refuses a second claim and signs the owner back in with the owner code", async () => {
    const { handlers } = make();
    await expect(handlers.connectServer({ serverUrl: base, setupToken: SETUP_TOKEN, ownerName: "Someone Else" })).rejects.toThrow(/already has an owner/);
    const code = store.data.people.find((p) => p.role === "owner")!;
    expect(code).toBeTruthy();
    expect((await handlers.checkServer(base)).claimed).toBe(true);
  });

  it("records, uploads, and reports voice/video progress; replaces a re-recorded prompt", async () => {
    const env = make();
    const { generateInviteCode, hashCode } = await import("../../server/src/auth.js");
    const code = generateInviteCode();
    store.update((db) => {
      db.people.find((p) => p.role === "owner")!.codeHash = hashCode(code);
    });
    await env.handlers.connectServer({ serverUrl: base, ownerCode: code });

    const wav = encodeWav([new Float32Array(16000 * 3)], 16000);
    const first = await env.handlers.uploadRecording({ purpose: "voice", filename: "read-01.wav", mimeType: "audio/wav", data: wav, durationSec: 62.5, promptId: "read-01", promptKind: "reading", quality: { verdict: "ok" } });
    expect(first).toMatchObject({ purpose: "voice", durationSec: 62.5, promptId: "read-01" });
    await env.handlers.uploadRecording({ purpose: "voice", filename: "read-01.wav", mimeType: "audio/wav", data: wav, durationSec: 70, promptId: "read-01", promptKind: "reading" });
    await env.handlers.uploadRecording({ purpose: "voice", filename: "story-01.wav", mimeType: "audio/wav", data: wav, durationSec: 100, promptId: "story-01", promptKind: "story" });
    const video = await env.handlers.uploadRecording({ purpose: "replica", filename: "training.webm", mimeType: "video/webm", data: new Uint8Array([1, 2, 3, 4]), durationSec: 121 });
    expect(video.kind).toBe("video");
    await env.handlers.uploadRecording({ purpose: "consent", filename: "consent.webm", mimeType: "video/webm", data: new Uint8Array([1, 2, 3, 4]), durationSec: 15 });

    const facts = (await env.handlers.getOnboarding())!.facts;
    expect(facts.voiceSeconds).toBe(170);
    expect(facts.voiceClips.map((c) => c.promptId).sort()).toEqual(["read-01", "story-01"]);
    expect(facts.replicaVideo?.durationSec).toBe(121);
    expect(facts.consentVideo).toBeTruthy();
  });

  it("walks the guided build, including the ElevenLabs verification pause, through the bridge", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cloneme-build-"));
    const config = loadConfig({ MOCK_MODE: "true", DATA_DIR: dir, SETUP_TOKEN, MOCK_REQUIRE_VERIFICATION: "true", SESSION_SECRET: "q".repeat(40) });
    const s2 = new Store(dir, config.ownerName);
    const server = createApp({ config, store: s2 }).app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const { handlers } = make();
      await handlers.connectServer({ serverUrl: url, setupToken: SETUP_TOKEN, ownerName: "Sam Rivera" });
      await expect(handlers.startBuild()).rejects.toThrow();
      const wav = encodeWav([new Float32Array(1600)], 16000);
      await handlers.uploadRecording({ purpose: "voice", filename: "a.wav", mimeType: "audio/wav", data: wav, durationSec: 1900, promptKind: "free" });
      await handlers.uploadRecording({ purpose: "replica", filename: "t.webm", mimeType: "video/webm", data: new Uint8Array([1]), durationSec: 120 });
      await handlers.uploadRecording({ purpose: "consent", filename: "c.webm", mimeType: "video/webm", data: new Uint8Array([1]), durationSec: 12 });
      await handlers.saveProfile({ basics: "Designer.", avoidTopics: [] });
      let b = await handlers.startBuild();
      for (let i = 0; i < 40 && !b.manualAction && !b.ready; i++) {
        await new Promise((r) => setTimeout(r, 50));
        b = await handlers.getBuild();
      }
      expect(b.manualAction?.id).toBe("elevenlabs-verification");
      expect(b.manualAction?.steps.length).toBeGreaterThan(2);
      expect(b.stages.find((st) => st.id === "voiceVerification")?.status).toBe("waiting");
      b = await handlers.confirmVoiceVerified();
      for (let i = 0; i < 80 && !b.ready; i++) {
        await new Promise((r) => setTimeout(r, 50));
        b = await handlers.getBuild();
      }
      expect(b.ready).toBe(true);
      expect(b.stages.every((st) => st.status === "done")).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe("media duration", () => {
  it("reads WAV headers exactly and flags estimates for compressed audio", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dur-"));
    const wavFile = path.join(dir, "a.wav");
    writeFileSync(wavFile, encodeWav([new Float32Array(44100 * 2)], 44100));
    expect(mediaDuration(wavFile)).toEqual({ seconds: 2, estimated: false });
    const mp3 = path.join(dir, "a.mp3");
    writeFileSync(mp3, Buffer.alloc(160000));
    expect(mediaDuration(mp3)).toEqual({ seconds: 10, estimated: true });
  });
});
