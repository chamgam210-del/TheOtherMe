import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyElevenLabs, verifyLlm, verifyTavus } from "../src/vendors/verify.js";
import { SecretStore } from "../src/secrets.js";
import { bearer, makeCtx, OWNER_CODE, ownerToken, type TestCtx } from "./helpers.js";

/** fetch double: responder returns a status (or [status, body]) per URL. */
function fakeFetch(responder: (url: string, init: RequestInit) => number | [number, unknown]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = responder(String(url), init);
    const [status, body] = Array.isArray(r) ? r : [r, {}];
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

const put = (ctx: TestCtx, token: string, name: string, query: string, type: string, body: string) =>
  ctx.api.put(`/api/owner/media?filename=${name}&${query}`).set(bearer(token)).set("content-type", type).send(body);

describe("instance secrets and server claim", () => {
  it("generates signing secrets once and keeps tokens valid across restarts", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cloneme-"));
    const env = { SESSION_SECRET: "", PERSONA_LLM_SHARED_SECRET: "" };
    const first = makeCtx(env, {}, { dir });
    const token = await ownerToken(first);
    expect(first.config.sessionSecret).toHaveLength(64);
    const second = makeCtx(env, {}, { dir });
    expect(second.config.sessionSecret).toBe(first.config.sessionSecret);
    expect((await second.api.get("/api/me").set(bearer(token))).status).toBe(200);
  });

  it("lets only the holder of the setup token claim an unclaimed server, once", async () => {
    const ctx = makeCtx({ OWNER_INVITE_CODE: "", SETUP_TOKEN: "setup-token-123456" });
    expect(ctx.ownerBootstrap.awaitingClaim).toBe(true);
    expect((await ctx.api.get("/healthz")).body).toMatchObject({ claimed: false, claimable: true });

    const bad = await ctx.api.post("/api/setup/claim").send({ setupToken: "wrong-token-123456", ownerName: "Pat Lee" });
    expect(bad.status).toBe(401);
    expect(ctx.store.data.people).toHaveLength(0);

    const ok = await ctx.api.post("/api/setup/claim").send({ setupToken: "setup-token-123456", ownerName: "Pat Lee" });
    expect(ok.status).toBe(201);
    expect(ok.body.person).toMatchObject({ name: "Pat Lee", role: "owner" });
    expect((await ctx.api.get("/api/owner/profile").set(bearer(ok.body.token))).body.displayName).toBe("Pat Lee");
    expect((await ctx.api.post("/api/auth/redeem").send({ code: ok.body.inviteCode })).status).toBe(200);

    const again = await ctx.api.post("/api/setup/claim").send({ setupToken: "setup-token-123456", ownerName: "Mallory" });
    expect(again.status).toBe(409);
    expect((await ctx.api.get("/healthz")).body).toMatchObject({ claimed: true, claimable: false });
  });

  it("rate limits setup-token guessing and is disabled without a token", async () => {
    const ctx = makeCtx({ OWNER_INVITE_CODE: "", SETUP_TOKEN: "setup-token-123456" });
    for (let i = 0; i < 8; i++) await ctx.api.post("/api/setup/claim").send({ setupToken: `guess-guess-${i}`, ownerName: "x" });
    const blocked = await ctx.api.post("/api/setup/claim").send({ setupToken: "setup-token-123456", ownerName: "Pat" });
    expect(blocked.status).toBe(429);
    const plain = makeCtx();
    expect((await plain.api.post("/api/setup/claim").send({ setupToken: "whatever-token", ownerName: "x" })).status).toBe(409);
  });

  it("reports https and storage facts for the app's reachability check", async () => {
    const ctx = makeCtx({ PERSISTENT_STORAGE: "true" });
    expect((await ctx.api.get("/healthz")).body).toMatchObject({ app: "cloneme", https: true, persistentStorage: true, publicBaseUrl: "https://api.example.test" });
  });
});

describe("keys saved from the app", () => {
  const live = { MOCK_MODE: "false" };

  it("verifies each key with a live call, stores only what passed, encrypted at rest, and never returns keys", async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.includes("tavusapi")) return 200;
      if (url.includes("elevenlabs")) return [200, { can_use_professional_voice_cloning: false }];
      if (url.includes("deepgram")) return 401;
      return 200;
    });
    const ctx = makeCtx(live, {}, { fetchImpl: impl, dynamicVendors: true });
    const owner = await ownerToken(ctx);
    const res = await ctx.api
      .put("/api/owner/keys")
      .set(bearer(owner))
      .send({ tavus: "tvs_secret_key_1", elevenlabs: "xi_secret_key_1", deepgram: "dg_bad_key_123", llm: { apiKey: "sk_secret_key_1", baseUrl: "https://llm.example/v1", model: "m1" } });
    expect(res.status).toBe(422);
    expect(res.body.results.tavus.ok).toBe(true);
    expect(res.body.results.elevenlabs.warning).toMatch(/Professional Voice Cloning/);
    expect(res.body.results.deepgram.ok).toBe(false);
    expect(res.body.results.llm.ok).toBe(true);
    expect(calls.find((c) => c.url.includes("tavusapi"))!.init.headers).toMatchObject({ "x-api-key": "tvs_secret_key_1" });

    expect(ctx.config.vendors.tavus.apiKey).toBe("tvs_secret_key_1");
    expect(ctx.config.vendors.tavus.mock).toBe(false);
    expect(ctx.config.vendors.deepgram.apiKey).toBeUndefined();
    expect(ctx.config.vendors.llm).toMatchObject({ baseUrl: "https://llm.example/v1", model: "m1" });
    expect(ctx.vendors.tavus.mock).toBe(false);
    expect(ctx.vendors.deepgram.mock).toBe(true);

    const view = await ctx.api.get("/api/owner/keys").set(bearer(owner));
    expect(JSON.stringify(view.body)).not.toMatch(/tvs_secret|xi_secret|sk_secret|dg_bad/);
    expect(view.body.vendors.tavus).toMatchObject({ configured: true, source: "app" });
    expect(view.body.vendors.deepgram).toMatchObject({ configured: false });

    const file = path.join(ctx.dir, "secrets.enc.json");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).not.toContain("tvs_secret_key_1");
    expect(readFileSync(path.join(ctx.dir, "db.json"), "utf8")).not.toContain("tvs_secret_key_1");
  });

  it("loads saved keys after a restart, and drops them if the encryption secret changes", async () => {
    const { impl } = fakeFetch(() => 200);
    const dir = mkdtempSync(path.join(tmpdir(), "cloneme-"));
    const a = makeCtx(live, {}, { dir, fetchImpl: impl });
    await a.api.put("/api/owner/keys").set(bearer(await ownerToken(a))).send({ tavus: "tvs_secret_key_1" });
    const b = makeCtx(live, {}, { dir });
    expect(b.config.vendors.tavus.apiKey).toBe("tvs_secret_key_1");
    expect(new SecretStore(dir, "a-different-secret-a-different-secret").load()).toEqual({});
  });

  it("rejects malformed keys, supports re-verify and removal, and is owner-only", async () => {
    const { impl } = fakeFetch(() => 200);
    const ctx = makeCtx(live, {}, { fetchImpl: impl, dynamicVendors: true });
    const owner = await ownerToken(ctx);
    expect((await ctx.api.put("/api/owner/keys").set(bearer(owner)).send({ tavus: "has space in it" })).status).toBe(400);
    await ctx.api.put("/api/owner/keys").set(bearer(owner)).send({ deepgram: "dg_secret_key_1" });
    const again = await ctx.api.post("/api/owner/keys/verify").set(bearer(owner)).send({});
    expect(again.body.results.deepgram.ok).toBe(true);
    expect(again.body.results.tavus).toEqual({ ok: false, message: "No key saved yet." });
    const del = await ctx.api.delete("/api/owner/keys/deepgram").set(bearer(owner));
    expect(del.body.vendors.deepgram.configured).toBe(false);
    expect(ctx.vendors.deepgram.mock).toBe(true);
    const friend = await (await import("./helpers.js")).invite(ctx, "Alex");
    expect((await ctx.api.get("/api/owner/keys").set(bearer(friend.token))).status).toBe(403);
  });

  it("does not call vendors in mock mode", async () => {
    const { impl, calls } = fakeFetch(() => 500);
    const ctx = makeCtx({}, {}, { fetchImpl: impl });
    const res = await ctx.api.put("/api/owner/keys").set(bearer(await ownerToken(ctx))).send({ tavus: "tvs_secret_key_1" });
    expect(res.status).toBe(200);
    expect(res.body.mockMode).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("vendor key verification", () => {
  it("explains rejected and unreachable keys in plain language", async () => {
    expect((await verifyTavus(fakeFetch(() => 401).impl, "k")).message).toMatch(/Tavus rejected this key/);
    const down = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect((await verifyTavus(down, "k")).message).toMatch(/Could not reach Tavus/);
    expect((await verifyTavus(fakeFetch(() => 500).impl, "k")).ok).toBe(false);
    expect((await verifyTavus(fakeFetch(() => 429).impl, "k")).ok).toBe(true);
  });

  it("flags plans without Professional Voice Cloning but still accepts the key", async () => {
    const r = await verifyElevenLabs(fakeFetch(() => [200, { can_use_professional_voice_cloning: false }]).impl, "k");
    expect(r.ok).toBe(true);
    expect(r.warning).toBeTruthy();
    expect((await verifyElevenLabs(fakeFetch(() => [200, { can_use_professional_voice_cloning: true }]).impl, "k")).warning).toBeUndefined();
  });

  it("falls back to a tiny chat call when the provider has no /models", async () => {
    const { impl, calls } = fakeFetch((url) => (url.endsWith("/models") ? 404 : 200));
    expect((await verifyLlm(impl, "k", "https://llm.example/v1/", "m")).ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["https://llm.example/v1/models", "https://llm.example/v1/chat/completions"]);
  });
});

describe("recording uploads and wizard facts", () => {
  it("stores duration, prompt and quality metadata and replaces a re-take of the same prompt", async () => {
    const ctx = makeCtx();
    const owner = await ownerToken(ctx);
    const q = encodeURIComponent(JSON.stringify({ verdict: "ok", peakDb: -3 }));
    const first = await put(ctx, owner, "r1.wav", `purpose=voice&durationSec=61.26&promptId=read-1&promptKind=reading&quality=${q}`, "audio/wav", "take one");
    expect(first.body).toMatchObject({ durationSec: 61.3, promptId: "read-1", promptKind: "reading", quality: { verdict: "ok" } });
    await put(ctx, owner, "r2.wav", "purpose=voice&durationSec=90&promptId=story-1&promptKind=story", "audio/wav", "story");
    await put(ctx, owner, "r1b.wav", "purpose=voice&durationSec=70&promptId=read-1&promptKind=reading", "audio/wav", "take two");

    expect(ctx.store.data.media.filter((m) => m.promptId === "read-1")).toHaveLength(1);
    const state = await ctx.api.get("/api/owner/onboarding").set(bearer(owner));
    expect(state.body.facts.voiceSeconds).toBe(160);
    expect(state.body.facts.voiceClips.map((c: any) => c.promptId).sort()).toEqual(["read-1", "story-1"]);
  });

  it("ignores absurd durations and bad prompt ids", async () => {
    const ctx = makeCtx();
    const owner = await ownerToken(ctx);
    const res = await put(ctx, owner, "a.wav", "purpose=voice&durationSec=999999&promptId=bad%20id!", "audio/wav", "x");
    expect(res.body.durationSec).toBeUndefined();
    expect(res.body.promptId).toBeUndefined();
  });

  it("saves wizard progress, consent and skips", async () => {
    const ctx = makeCtx();
    const owner = await ownerToken(ctx);
    const res = await ctx.api.put("/api/owner/onboarding").set(bearer(owner)).send({ consentAccepted: true, consentName: "Sam Rivera", currentStep: "keys", skipped: { invite: true }, avoidNone: true });
    expect(res.body.state).toMatchObject({ consentName: "Sam Rivera", currentStep: "keys", skipped: { invite: true }, avoidNone: true });
    expect(res.body.state.consentAcceptedAt).toBeTruthy();
    const get = await ctx.api.get("/api/owner/onboarding").set(bearer(owner));
    expect(get.body.state.currentStep).toBe("keys");
    expect((await ctx.api.put("/api/owner/onboarding").set(bearer(owner)).send({ consentName: "x" })).status).toBe(400);
  });

  it("stores questionnaire answers with the profile", async () => {
    const ctx = makeCtx();
    const owner = await ownerToken(ctx);
    await ctx.api.put("/api/owner/profile").set(bearer(owner)).send({ answers: { hometown: "Portland" }, basics: "From Portland." });
    const get = await ctx.api.get("/api/owner/onboarding").set(bearer(owner));
    expect(get.body.facts.profile.answers).toEqual({ hometown: "Portland" });
  });
});

describe("guided build", () => {
  async function ready(ctx: TestCtx, token: string) {
    await put(ctx, token, "r.wav", "purpose=voice&durationSec=120&promptId=read-1&promptKind=reading", "audio/wav", "reading audio");
    await put(ctx, token, "s.wav", "purpose=voice&durationSec=120&promptId=story-1&promptKind=story", "audio/wav", "Speaker 0: I grew up in Portland and I love hiking.\nSpeaker 0: Honestly it was a great place to grow up, you know?");
    await put(ctx, token, "face.webm", "purpose=replica&durationSec=120", "video/webm", "video");
    await put(ctx, token, "consent.webm", "purpose=consent&durationSec=15", "video/webm", "consent");
  }

  it("refuses to start until recordings exist and names what is missing", async () => {
    const ctx = makeCtx();
    const owner = await ownerToken(ctx);
    const res = await ctx.api.post("/api/owner/build/start").set(bearer(owner)).send({});
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/voice recordings.*training video.*consent video/);
    const idle = await ctx.api.get("/api/owner/build").set(bearer(owner));
    expect(idle.body.started).toBe(false);
  });

  it("runs transcription, voice, replica and persona to ready in mock mode, skipping reading passages for style", async () => {
    const ctx = makeCtx();
    const owner = await ownerToken(ctx);
    await ready(ctx, owner);
    let status = (await ctx.api.post("/api/owner/build/start").set(bearer(owner)).send({})).body;
    expect(status.started).toBe(true);
    for (let i = 0; i < 20 && !status.ready; i++) {
      await new Promise((r) => setTimeout(r, 25));
      status = (await ctx.api.get("/api/owner/build").set(bearer(owner))).body;
    }
    expect(status.stages.map((s: any) => [s.id, s.status])).toEqual([
      ["transcription", "done"], ["voice", "done"], ["voiceVerification", "done"], ["replica", "done"], ["persona", "done"],
    ]);
    expect(status.ready).toBe(true);
    expect(ctx.store.data.transcripts).toHaveLength(1);
    expect(ctx.store.data.media.find((m) => m.promptId === "read-1")!.processedAt).toBeUndefined();
    expect(ctx.store.data.vendor.personaId).toMatch(/^mock_persona/);
    const facts = (await ctx.api.get("/api/owner/onboarding").set(bearer(owner))).body.facts;
    expect(facts.ready).toBe(true);
  });

  it("pauses for ElevenLabs verification, then trains once the owner confirms", async () => {
    const ctx = makeCtx({ MOCK_REQUIRE_VERIFICATION: "true" }, {}, { dynamicVendors: true });
    const owner = await ownerToken(ctx);
    await ready(ctx, owner);
    await ctx.api.post("/api/owner/build/start").set(bearer(owner)).send({});
    const waiting = (await ctx.api.get("/api/owner/build").set(bearer(owner))).body;
    expect(waiting.stages.find((s: any) => s.id === "voiceVerification").status).toBe("waiting");
    expect(waiting.manualAction.id).toBe("elevenlabs-verification");
    expect(waiting.manualAction.steps.length).toBeGreaterThanOrEqual(3);
    expect(waiting.stages.find((s: any) => s.id === "persona").status).toBe("pending");

    const confirmed = await ctx.api.post("/api/owner/build/verified").set(bearer(owner)).send({});
    expect(confirmed.status).toBe(200);
    let status = confirmed.body;
    for (let i = 0; i < 20 && !status.ready; i++) {
      await new Promise((r) => setTimeout(r, 25));
      status = (await ctx.api.get("/api/owner/build").set(bearer(owner))).body;
    }
    expect(status.ready).toBe(true);
    expect(status.manualAction).toBeNull();
  });

  it("tells the owner when ElevenLabs does not yet show the voice as verified", async () => {
    const ctx = makeCtx({ MOCK_REQUIRE_VERIFICATION: "true" }, {}, { dynamicVendors: true });
    const owner = await ownerToken(ctx);
    await ready(ctx, owner);
    await ctx.api.post("/api/owner/build/start").set(bearer(owner)).send({});
    ctx.vendors.elevenlabs.startPvcTraining = async () => {
      throw new Error("still unverified");
    };
    const res = await ctx.api.post("/api/owner/build/verified").set(bearer(owner)).send({});
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/does not show this voice as verified yet/);
  });

  it("shows a failed stage and can retry it after the owner fixes the cause", async () => {
    const ctx = makeCtx();
    const owner = await ownerToken(ctx);
    await ready(ctx, owner);
    const original = ctx.tavus.createReplica.bind(ctx.tavus);
    ctx.tavus.createReplica = async () => {
      throw new Error("tavus 422: consent video did not match");
    };
    await ctx.api.post("/api/owner/build/start").set(bearer(owner)).send({});
    const failed = (await ctx.api.get("/api/owner/build").set(bearer(owner))).body;
    expect(failed.stages.find((s: any) => s.id === "replica")).toMatchObject({ status: "failed" });
    expect(failed.stages.find((s: any) => s.id === "replica").detail).toMatch(/consent video did not match/);

    ctx.tavus.createReplica = original;
    const retried = await ctx.api.post("/api/owner/build/retry").set(bearer(owner)).send({ stage: "replica" });
    expect(retried.status).toBe(200);
    expect(retried.body.stages.find((s: any) => s.id === "replica").status).not.toBe("failed");
    expect((await ctx.api.post("/api/owner/build/retry").set(bearer(owner)).send({ stage: "nope" })).status).toBe(400);
  });
});
