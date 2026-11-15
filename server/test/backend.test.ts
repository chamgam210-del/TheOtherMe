import { describe, expect, it } from "vitest";
import { generateInviteCode, hashCode, normalizeCode, signToken, verifyToken, AttemptLimiter } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { signedMediaUrl } from "../src/media.js";
import { bearer, invite, login, makeCtx, ownerToken, OWNER_CODE } from "./helpers.js";

describe("invite-code auth", () => {
  it("generates readable codes and normalizes input", () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(hashCode(code.toLowerCase().replace(/-/g, " "))).toBe(hashCode(code));
    expect(normalizeCode("ab-cd 12")).toBe("ABCD12");
  });

  it("redeems a valid code for a token and rejects unknown codes", async () => {
    const ctx = makeCtx();
    const ok = await ctx.api.post("/api/auth/redeem").send({ code: OWNER_CODE.toLowerCase() });
    expect(ok.status).toBe(200);
    expect(ok.body.person).toMatchObject({ name: "Sam Rivera", role: "owner" });
    expect(ok.body.token).toBeTruthy();
    expect(JSON.stringify(ok.body)).not.toContain("codeHash");

    const bad = await ctx.api.post("/api/auth/redeem").send({ code: "NOPE-NOPE-NOPE" });
    expect(bad.status).toBe(401);
  });

  it("rate limits repeated bad codes", async () => {
    const ctx = makeCtx();
    for (let i = 0; i < 10; i++) await ctx.api.post("/api/auth/redeem").send({ code: `WRONG-CODE-${i}0` });
    const blocked = await ctx.api.post("/api/auth/redeem").send({ code: OWNER_CODE });
    expect(blocked.status).toBe(429);
  });

  it("AttemptLimiter expires old failures", () => {
    const l = new AttemptLimiter(2, 1000);
    l.fail("a", 0);
    l.fail("a", 10);
    expect(l.blocked("a", 20)).toBe(true);
    expect(l.blocked("a", 5000)).toBe(false);
  });

  it("tokens are tamper-proof and expire", () => {
    const config = loadConfig({ SESSION_SECRET: "x".repeat(40), TOKEN_TTL_SECONDS: "60" });
    const token = signToken(config, "per_1", 0);
    expect(verifyToken(config, token, 1000)?.pid).toBe("per_1");
    expect(verifyToken(config, token, 61_000)).toBeNull();
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ pid: "per_2", exp: 9e9 })).toString("base64url");
    expect(verifyToken(config, `${forged}.${sig}`, 1000)).toBeNull();
    expect(verifyToken(config, `${body}.AAAA`, 1000)).toBeNull();
  });

  it("protects routes and revokes access immediately", async () => {
    const ctx = makeCtx();
    expect((await ctx.api.get("/api/me")).status).toBe(401);
    const friend = await invite(ctx, "Alex");
    expect((await ctx.api.get("/api/me").set(bearer(friend.token))).status).toBe(200);

    const owner = await ownerToken(ctx);
    const revoke = await ctx.api.delete(`/api/owner/people/${friend.person.id}`).set(bearer(owner));
    expect(revoke.status).toBe(200);
    expect((await ctx.api.get("/api/me").set(bearer(friend.token))).status).toBe(401);
    expect((await ctx.api.post("/api/auth/redeem").send({ code: friend.code })).status).toBe(401);
  });

  it("requires production secrets", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/SESSION_SECRET/);
  });
});

describe("session broker", () => {
  it("creates a Tavus conversation with a per-person participant tag and keeps vendor secrets out of the response", async () => {
    const ctx = makeCtx();
    const alex = await invite(ctx, "Alex Kim", "friend");
    const res = await ctx.api.post("/api/sessions").set(bearer(alex.token)).send({});
    expect(res.status).toBe(201);
    expect(res.body.conversationUrl).toMatch(/^mock:\/\//);
    expect(res.body.banner).toEqual({ text: "AI version of Sam Rivera" });
    expect(res.body.greeting).toContain("Alex");
    expect(JSON.stringify(res.body)).not.toMatch(/api[_-]?key|secret/i);

    const call = ctx.tavus.conversations[0]!;
    expect(call.participantTag).toBe(`p_${alex.person.id}`);
    expect(call.conversationalContext).toContain(`[[cloneme:person=${alex.person.id}]]`);
    expect(call.maxCallSeconds).toBe(1800);
  });

  it("gives family no banner by default and different tags per person", async () => {
    const ctx = makeCtx();
    const mom = await invite(ctx, "Mom", "family", "mother");
    const alex = await invite(ctx, "Alex", "friend");
    const a = await ctx.api.post("/api/sessions").set(bearer(mom.token)).send({});
    const b = await ctx.api.post("/api/sessions").set(bearer(alex.token)).send({});
    expect(a.body.banner).toBeNull();
    expect(b.body.banner).not.toBeNull();
    expect(new Set(ctx.tavus.conversations.map((c) => c.participantTag)).size).toBe(2);
  });

  it("ends the previous call when the same person starts another, and enforces the concurrency cap", async () => {
    const ctx = makeCtx({ MAX_CONCURRENT_SESSIONS: "1" });
    const a = await invite(ctx, "A");
    const b = await invite(ctx, "B");
    const first = await ctx.api.post("/api/sessions").set(bearer(a.token)).send({});
    const again = await ctx.api.post("/api/sessions").set(bearer(a.token)).send({});
    expect(again.status).toBe(201);
    expect(ctx.store.data.sessions.find((s) => s.id === first.body.sessionId)?.status).toBe("ended");
    const busy = await ctx.api.post("/api/sessions").set(bearer(b.token)).send({});
    expect(busy.status).toBe(429);
    expect(busy.body.error).toBe("busy");
  });

  it("lets only the owner of a session end it, and ends it upstream", async () => {
    const ctx = makeCtx();
    const a = await invite(ctx, "A");
    const b = await invite(ctx, "B");
    const { body } = await ctx.api.post("/api/sessions").set(bearer(a.token)).send({});
    expect((await ctx.api.post(`/api/sessions/${body.sessionId}/end`).set(bearer(b.token))).status).toBe(404);
    expect((await ctx.api.post(`/api/sessions/${body.sessionId}/end`).set(bearer(a.token))).status).toBe(200);
    expect(ctx.store.data.sessions[0]!.status).toBe("ended");
  });

  it("reports not_configured when live mode lacks replica/persona ids", async () => {
    const ctx = makeCtx();
    Object.defineProperty(ctx.tavus, "mock", { value: false });
    const a = await invite(ctx, "A");
    const res = await ctx.api.post("/api/sessions").set(bearer(a.token)).send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("not_configured");
  });

  it("surfaces vendor failures as 502 without leaking details", async () => {
    const ctx = makeCtx();
    ctx.tavus.createConversation = async () => {
      throw new Error("tavus 401: invalid key sk_live_123");
    };
    const a = await invite(ctx, "A");
    const res = await ctx.api.post("/api/sessions").set(bearer(a.token)).send({});
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain("sk_live");
  });

  it("serves the text fallback through the persona and rejects ended sessions", async () => {
    const ctx = makeCtx();
    const a = await invite(ctx, "A");
    const { body } = await ctx.api.post("/api/sessions").set(bearer(a.token)).send({});
    const reply = await ctx.api.post(`/api/sessions/${body.sessionId}/text`).set(bearer(a.token)).send({ text: "hello there" });
    expect(reply.status).toBe(200);
    expect(reply.body.reply.length).toBeGreaterThan(0);
    expect((await ctx.api.post(`/api/sessions/${body.sessionId}/text`).set(bearer(a.token)).send({ text: "" })).status).toBe(400);
    await ctx.api.post(`/api/sessions/${body.sessionId}/end`).set(bearer(a.token));
    expect((await ctx.api.post(`/api/sessions/${body.sessionId}/text`).set(bearer(a.token)).send({ text: "hi" })).status).toBe(404);
  });

  it("ends sessions from the Tavus shutdown webhook, honoring the shared secret", async () => {
    const ctx = makeCtx({ TAVUS_WEBHOOK_SECRET: "hook" });
    const a = await invite(ctx, "A");
    await ctx.api.post("/api/sessions").set(bearer(a.token)).send({});
    const convo = ctx.store.data.sessions[0]!.conversationId;
    expect((await ctx.api.post("/webhooks/tavus").send({ conversation_id: convo, event_type: "system.shutdown" })).status).toBe(401);
    expect((await ctx.api.post("/webhooks/tavus?secret=hook").send({ conversation_id: convo, event_type: "system.shutdown" })).status).toBe(200);
    expect(ctx.store.data.sessions[0]!.status).toBe("ended");
  });
});

describe("owner API", () => {
  it("is owner-only", async () => {
    const ctx = makeCtx();
    const friend = await invite(ctx, "Alex");
    for (const p of ["/api/owner/profile", "/api/owner/people", "/api/owner/media", "/api/owner/vendors"]) {
      expect((await ctx.api.get(p).set(bearer(friend.token))).status).toBe(403);
      expect((await ctx.api.get(p)).status).toBe(401);
    }
  });

  it("adds people (code shown once), regenerates codes and never exposes hashes", async () => {
    const ctx = makeCtx();
    const owner = await ownerToken(ctx);
    const created = await ctx.api.post("/api/owner/people").set(bearer(owner)).send({ name: "Dana", role: "family", relationship: "sister" });
    expect(created.status).toBe(201);
    expect(created.body.inviteCode).toMatch(/-/);
    expect(await login(ctx, created.body.inviteCode)).toBeTruthy();

    const list = await ctx.api.get("/api/owner/people").set(bearer(owner));
    expect(JSON.stringify(list.body)).not.toMatch(/codeHash|inviteCode/);

    const regen = await ctx.api.post(`/api/owner/people/${created.body.person.id}/code`).set(bearer(owner));
    expect((await ctx.api.post("/api/auth/redeem").send({ code: created.body.inviteCode })).status).toBe(401);
    expect(await login(ctx, regen.body.inviteCode)).toBeTruthy();

    const self = ctx.store.data.people.find((p) => p.role === "owner")!;
    expect((await ctx.api.delete(`/api/owner/people/${self.id}`).set(bearer(owner))).status).toBe(400);
  });

  it("edits the profile with validation", async () => {
    const ctx = makeCtx();
    const owner = await ownerToken(ctx);
    const put = await ctx.api
      .put("/api/owner/profile")
      .set(bearer(owner))
      .send({ basics: "I'm a designer.", avoidTopics: ["my ex", "politics"], family: [{ name: "Dana", relationship: "sister" }] });
    expect(put.status).toBe(200);
    expect(ctx.store.data.profile.avoidTopics).toEqual(["my ex", "politics"]);
    const bad = await ctx.api.put("/api/owner/profile").set(bearer(owner)).send({ avoidTopics: "politics" });
    expect(bad.status).toBe(400);
  });

  it("uploads, lists and deletes media, enforcing purpose and size", async () => {
    const ctx = makeCtx({ MAX_UPLOAD_MB: "1" });
    const owner = await ownerToken(ctx);
    const up = await ctx.api
      .put("/api/owner/media?filename=notes.txt&purpose=training")
      .set(bearer(owner))
      .set("content-type", "text/plain")
      .send("I love hiking. I grew up in Portland.");
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ kind: "text", purpose: "training" });

    const jsonUpload = await ctx.api
      .put("/api/owner/media?filename=chat.json&purpose=training")
      .set(bearer(owner))
      .set("content-type", "application/json")
      .send('{"a":1}');
    expect(jsonUpload.status).toBe(201);

    expect((await ctx.api.put("/api/owner/media?filename=x.txt&purpose=bogus").set(bearer(owner)).send("hi")).status).toBe(400);
    const big = await ctx.api
      .put("/api/owner/media?filename=big.wav&purpose=voice")
      .set(bearer(owner))
      .set("content-type", "audio/wav")
      .send(Buffer.alloc(1024 * 1024 + 10));
    expect(big.status).toBe(413);
    expect(ctx.store.data.media).toHaveLength(2);

    const del = await ctx.api.delete(`/api/owner/media/${up.body.id}`).set(bearer(owner));
    expect(del.status).toBe(200);
    expect(ctx.store.data.media).toHaveLength(1);
  });

  it("serves signed media links only with a valid signature", async () => {
    const ctx = makeCtx();
    const owner = await ownerToken(ctx);
    const up = await ctx.api
      .put("/api/owner/media?filename=train.mp4&purpose=replica")
      .set(bearer(owner))
      .set("content-type", "video/mp4")
      .send("fake video bytes");
    const url = new URL(signedMediaUrl(ctx.config, up.body.id));
    const ok = await ctx.api.get(url.pathname + url.search);
    expect(ok.status).toBe(200);
    expect((await ctx.api.get(`${url.pathname}?exp=${url.searchParams.get("exp")}&sig=bad`)).status).toBe(404);
    expect((await ctx.api.get(`${url.pathname}?exp=1&sig=${url.searchParams.get("sig")}`)).status).toBe(404);
  });

  it("runs voice, replica and persona setup end to end in mock mode and then enables calls", async () => {
    const ctx = makeCtx();
    const owner = await ownerToken(ctx);
    const put = (name: string, purpose: string, type: string, body: string) =>
      ctx.api.put(`/api/owner/media?filename=${name}&purpose=${purpose}`).set(bearer(owner)).set("content-type", type).send(body);

    expect((await ctx.api.post("/api/owner/vendors/voice").set(bearer(owner)).send({})).body.error).toBe("no_voice_samples");
    await put("speech.wav", "voice", "audio/wav", "pretend audio");
    const voice = await ctx.api.post("/api/owner/vendors/voice").set(bearer(owner)).send({});
    expect(voice.status).toBe(200);
    expect(voice.body.voiceId).toMatch(/^mock_voice/);

    expect((await ctx.api.post("/api/owner/vendors/replica").set(bearer(owner)).send({})).body.error).toBe("no_training_video");
    await put("face.mp4", "replica", "video/mp4", "pretend video");
    expect((await ctx.api.post("/api/owner/vendors/replica").set(bearer(owner)).send({})).body.error).toBe("no_consent_video");
    await put("consent.mp4", "consent", "video/mp4", "pretend consent");
    expect((await ctx.api.post("/api/owner/vendors/replica").set(bearer(owner)).send({})).status).toBe(200);

    const persona = await ctx.api.post("/api/owner/vendors/persona").set(bearer(owner)).send({});
    expect(persona.body.personaId).toMatch(/^mock_persona/);

    const status = await ctx.api.get("/api/owner/vendors?sync=1").set(bearer(owner));
    expect(status.body).toMatchObject({ readyForCalls: true, voice: { status: "ready" }, mode: { tavus: "mock" } });
  });

  it("persists state across restarts", async () => {
    const ctx = makeCtx();
    const alex = await invite(ctx, "Alex");
    const { Store } = await import("../src/store.js");
    const reopened = new Store(ctx.dir, "Sam Rivera");
    expect(reopened.data.people.some((p) => p.id === alex.person.id)).toBe(true);
  });
});

describe("health", () => {
  it("reports vendor modes without exposing keys", async () => {
    const ctx = makeCtx();
    const res = await ctx.api.get("/healthz");
    expect(res.body).toMatchObject({ ok: true, mode: { tavus: "mock", elevenlabs: "mock", deepgram: "mock", llm: "mock" } });
  });
});
