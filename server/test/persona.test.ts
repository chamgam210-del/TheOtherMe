import { describe, expect, it } from "vitest";
import { guardStream, DEFLECTION, topicMatcher } from "../src/persona/guard.js";
import { extractPersonNotes, getMemory, recordTurn } from "../src/persona/memory.js";
import { buildGreeting, buildSystemPrompt, personMarker } from "../src/persona/prompt.js";
import { bearer, invite, makeCtx, ownerToken, RecordingLlm, type TestCtx } from "./helpers.js";

const SECRET = { authorization: "Bearer persona-secret-persona-secret" };

async function setProfile(ctx: TestCtx) {
  const owner = await ownerToken(ctx);
  await ctx.api
    .put("/api/owner/profile")
    .set(bearer(owner))
    .send({
      basics: "I'm a product designer who loves hiking.",
      birthplace: "Portland",
      avoidTopics: ["my ex", "politics"],
      family: [{ name: "Dana", relationship: "sister", notes: "lives in Seattle" }],
    });
  return owner;
}

const systemOf = (ctx: TestCtx) => ctx.llm.calls.at(-1)!.find((m) => m.role === "system")!.content;

describe("persona prompt", () => {
  it("includes profile, family, approved facts, style and avoid topics but not pending facts", async () => {
    const ctx = makeCtx();
    await setProfile(ctx);
    ctx.store.update((db) => {
      db.facts.push(
        { id: "f1", text: "I run every morning", source: "t", status: "approved", createdAt: "" },
        { id: "f2", text: "I secretly hate cilantro", source: "t", status: "pending", createdAt: "" },
      );
      db.style = {
        sampleCount: 5, wordCount: 100, avgSentenceWords: 6, questionRate: 0.3, exclamationRate: 0.2,
        contractionRate: 0.9, emojiRate: 0, lowercaseStartRate: 0, fillers: [{ phrase: "you know", count: 4 }],
        openers: ["honestly i"], signaturePhrases: ["no worries at all"], examples: ["Honestly I just love getting outside, you know?"],
        voiceDescription: "You are warm and teasing.", updatedAt: "",
      };
    });
    const prompt = buildSystemPrompt({ ...ctx.store.data, person: null, memory: null });
    expect(prompt).toContain("AI version of Sam Rivera");
    expect(prompt).toContain("product designer");
    expect(prompt).toContain("Dana (sister): lives in Seattle");
    expect(prompt).toContain("I run every morning");
    expect(prompt).not.toContain("cilantro");
    expect(prompt).toContain("You are warm and teasing.");
    expect(prompt).toContain("no worries at all");
    expect(prompt).toContain("Never bring up or discuss: my ex; politics");
    expect(prompt).toMatch(/AI version of Sam Rivera, not the real person/);
  });

  it("greets by name and acknowledges returning people", () => {
    const profile = makeCtx().store.data.profile;
    const person = { id: "p", name: "Alex Kim", role: "friend", relationship: "friend" } as any;
    expect(buildGreeting(profile, person, null)).toContain("Alex");
    expect(buildGreeting(profile, person, { personId: "p", notes: [], turns: [], lastConversationAt: "x" })).toContain("again");
    expect(personMarker("per_1")).toBe("[[cloneme:person=per_1]]");
  });
});

describe("OpenAI-compatible endpoint", () => {
  it("rejects missing or wrong bearer secrets", async () => {
    const ctx = makeCtx();
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect((await ctx.api.post("/v1/chat/completions").send(body)).status).toBe(401);
    expect((await ctx.api.post("/v1/chat/completions").set({ authorization: "Bearer nope" }).send(body)).status).toBe(401);
    expect((await ctx.api.get("/v1/models").set(SECRET)).body.data[0].id).toBe("cloneme-persona");
  });

  it("returns a standard non-streaming completion and validates input", async () => {
    const ctx = makeCtx();
    const ok = await ctx.api.post("/v1/chat/completions").set(SECRET).send({ messages: [{ role: "user", content: "hi" }] });
    expect(ok.status).toBe(200);
    expect(ok.body.object).toBe("chat.completion");
    expect(ok.body.choices[0].message).toMatchObject({ role: "assistant", content: "Sounds good. Tell me more." });
    expect((await ctx.api.post("/v1/chat/completions").set(SECRET).send({ messages: [] })).status).toBe(400);
  });

  it("streams SSE chunks ending with [DONE]", async () => {
    const ctx = makeCtx();
    const res = await ctx.api
      .post("/v1/chat/completions")
      .set(SECRET)
      .send({ stream: true, messages: [{ role: "user", content: "hi" }] })
      .buffer(true)
      .parse((r, cb) => {
        let data = "";
        r.on("data", (c) => (data += c));
        r.on("end", () => cb(null, data));
      });
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const text = res.body as string;
    const events = text.split("\n\n").filter(Boolean);
    expect(events.at(-1)).toBe("data: [DONE]");
    const deltas = events
      .filter((e) => e !== "data: [DONE]")
      .map((e) => JSON.parse(e.slice(6)).choices[0].delta.content)
      .filter(Boolean)
      .join("");
    expect(deltas).toBe("Sounds good. Tell me more.");
  });

  it("identifies the person from the Tavus system message marker, strips it, and discards Tavus's own system prompt", async () => {
    const ctx = makeCtx();
    await setProfile(ctx);
    const alex = await invite(ctx, "Alex Kim", "friend");
    await ctx.api
      .post("/v1/chat/completions")
      .set(SECRET)
      .send({
        messages: [
          { role: "system", content: `You are a helpful bot. ${personMarker(alex.person.id)}` },
          { role: "user", content: [{ type: "text", text: "hello there" }] },
        ],
      });
    const system = systemOf(ctx);
    expect(system).toContain("Alex Kim");
    expect(system).not.toContain("helpful bot");
    expect(system).not.toContain("cloneme:person");
    const sent = ctx.llm.calls.at(-1)!;
    expect(sent.at(-1)).toEqual({ role: "user", content: "hello there" });
  });

  it("keeps memory strictly per person", async () => {
    const ctx = makeCtx();
    const alex = await invite(ctx, "Alex Kim");
    const mom = await invite(ctx, "Mom", "family", "mother");
    const ask = (id: string, text: string) =>
      ctx.api
        .post("/v1/chat/completions")
        .set(SECRET)
        .send({ messages: [{ role: "system", content: personMarker(id) }, { role: "user", content: text }] });

    await ask(alex.person.id, "My dog Biscuit just had surgery and I'm worried.");
    await ask(mom.person.id, "How are you doing, sweetheart?");
    expect(getMemory(ctx.store, alex.person.id).notes.join(" ")).toContain("Biscuit");
    expect(getMemory(ctx.store, mom.person.id).notes.join(" ")).not.toContain("Biscuit");

    await ask(mom.person.id, "Tell me about your week.");
    expect(systemOf(ctx)).not.toContain("Biscuit");
    await ask(alex.person.id, "Remember me?");
    expect(systemOf(ctx)).toContain("Biscuit");
    expect(systemOf(ctx)).toContain("Never share what Alex Kim told you");
  });

  it("treats unknown or revoked people as anonymous and stores no memory", async () => {
    const ctx = makeCtx();
    const alex = await invite(ctx, "Alex");
    const owner = await ownerToken(ctx);
    await ctx.api.delete(`/api/owner/people/${alex.person.id}`).set(bearer(owner));
    await ctx.api
      .post("/v1/chat/completions")
      .set(SECRET)
      .send({ messages: [{ role: "system", content: personMarker(alex.person.id) }, { role: "user", content: "I have a secret plan." }] });
    expect(systemOf(ctx)).toContain("do not know who you are talking with");
    expect(ctx.store.data.memories[alex.person.id]).toBeUndefined();
  });

  it("steers away from avoid-topics and blocks replies that mention them", async () => {
    const llm = new RecordingLlm(() => "Oh, politics is wild. Anyway I went hiking.");
    const ctx = makeCtx({}, { llm });
    await setProfile(ctx);
    const res = await ctx.api
      .post("/v1/chat/completions")
      .set(SECRET)
      .send({ messages: [{ role: "user", content: "What do you think about politics?" }] });
    expect(systemOf(ctx)).toContain("just touched on one of those topics");
    expect(res.body.choices[0].message.content).toBe(DEFLECTION);
  });

  it("returns a clean 502 when the upstream LLM fails", async () => {
    const llm = new RecordingLlm(() => {
      throw new Error("boom");
    });
    const ctx = makeCtx({}, { llm });
    const res = await ctx.api.post("/v1/chat/completions").set(SECRET).send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(502);
  });
});

describe("guard and memory helpers", () => {
  it("matches whole phrases case-insensitively", () => {
    const hit = topicMatcher(["my ex", "Politics"]);
    expect(hit("We shouldn't talk about my EX.")).toBe(true);
    expect(hit("geopolitics is fine")).toBe(false);
    expect(hit("nothing here")).toBe(false);
  });

  it("passes clean sentences through and cuts at the first violation", async () => {
    async function* src(parts: string[]) {
      yield* parts;
    }
    const collect = async (parts: string[]) => {
      let out = "";
      for await (const p of guardStream(src(parts), ["taxes"])) out += p;
      return out;
    };
    expect(await collect(["Hi the", "re. How are ", "you?"])).toBe("Hi there. How are you?");
    expect(await collect(["Fine. I hate tax", "es. Really. More text."])).toBe(`Fine. ${DEFLECTION}`);
    expect(await collect(["I hate taxes"])).toBe(DEFLECTION);
  });

  it("extracts first-person notes only and dedupes repeated utterances", () => {
    expect(extractPersonNotes("Nice day. My daughter started school today. Wow!")).toEqual(["My daughter started school today"]);
    const ctx = makeCtx();
    const now = new Date();
    recordTurn(ctx.store, "p1", "I just moved to Denver.", "Cool!", now);
    recordTurn(ctx.store, "p1", "I just moved to Denver.", "Nice one!", new Date(now.getTime() + 1000));
    const mem = getMemory(ctx.store, "p1");
    expect(mem.turns).toHaveLength(2);
    expect(mem.turns[1]!.content).toBe("Nice one!");
    expect(mem.notes).toEqual(["I just moved to Denver"]);
  });

  it("lets the owner clear a person's memory", async () => {
    const ctx = makeCtx();
    const alex = await invite(ctx, "Alex");
    recordTurn(ctx.store, alex.person.id, "I have a cat named Pixel.", "Aw.");
    const owner = await ownerToken(ctx);
    await ctx.api.delete(`/api/owner/people/${alex.person.id}/memory`).set(bearer(owner));
    expect(getMemory(ctx.store, alex.person.id).notes).toEqual([]);
  });
});
