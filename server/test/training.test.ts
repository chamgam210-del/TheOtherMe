import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mediaDirOf } from "../src/media.js";
import { buildSystemPrompt } from "../src/persona/prompt.js";
import { heuristicFacts } from "../src/training/facts.js";
import { collectOwnerUtterances, pickOwnerSpeaker, runTraining, startTraining } from "../src/training/pipeline.js";
import { extractStyle } from "../src/training/style.js";
import { parseDeepgram } from "../src/vendors/deepgram.js";
import { bearer, makeCtx, ownerToken, RecordingLlm, type TestCtx } from "./helpers.js";

const OWNER_LINES = [
  "Honestly I just love getting outside, you know? It clears my head.",
  "No worries at all, we can figure it out tomorrow.",
  "I'm from Portland originally and I grew up on the east side.",
  "Honestly I think it's gonna be fine, you know what I mean?",
  "No worries at all! I'll bring snacks.",
  "My sister Dana lives in Seattle and we talk every Sunday.",
  "You know, I don't really like crowds. I'd rather hike.",
  "Honestly it's been a wild year. No worries at all though.",
];

function addMedia(ctx: TestCtx, name: string, content: string, kind: "audio" | "video" | "text", purpose = "training", extra: object = {}) {
  mkdirSync(mediaDirOf(ctx.config), { recursive: true });
  const id = `med_${name}`;
  const storedAs = `${id}${path.extname(name)}`;
  writeFileSync(path.join(mediaDirOf(ctx.config), storedAs), content);
  ctx.store.update((db) =>
    db.media.push({ id, kind, filename: name, storedAs, bytes: content.length, mimeType: "application/octet-stream", purpose: purpose as any, createdAt: "", ...extra }),
  );
  return id;
}

const deps = (ctx: TestCtx) => ({ store: ctx.store, vendors: ctx.vendors, mediaDir: mediaDirOf(ctx.config) });

describe("style extraction", () => {
  const style = extractStyle(OWNER_LINES, new Date("2026-01-01T00:00:00Z"));

  it("computes counts and rates", () => {
    expect(style.sampleCount).toBe(8);
    expect(style.wordCount).toBeGreaterThan(60);
    expect(style.exclamationRate).toBeGreaterThan(0);
    expect(style.questionRate).toBeGreaterThan(0);
    expect(style.contractionRate).toBeGreaterThan(0.9);
    expect(style.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("finds fillers, openers, signature phrases and examples", () => {
    expect(style.fillers.map((f) => f.phrase)).toContain("you know");
    expect(style.fillers.map((f) => f.phrase)).toContain("honestly");
    expect(style.openers).toContain("honestly i");
    expect(style.signaturePhrases).toContain("no worries at all");
    expect(style.examples.length).toBeGreaterThan(0);
    expect(style.examples.length).toBeLessThanOrEqual(8);
  });

  it("is stable on empty input", () => {
    const empty = extractStyle([]);
    expect(empty.sampleCount).toBe(0);
    expect(empty.avgSentenceWords).toBe(0);
    expect(empty.examples).toEqual([]);
  });
});

describe("fact extraction", () => {
  it("keeps first-person biography and drops questions, chatter and duplicates", () => {
    const facts = heuristicFacts([
      "Well, I grew up in Portland on the east side.",
      "I grew up in Portland on the east side.",
      "My sister Dana lives in Seattle.",
      "What do you think about that?",
      "That sounds great honestly.",
      "I'm a product designer at a small studio.",
    ]);
    expect(facts).toEqual([
      "I grew up in Portland on the east side",
      "My sister Dana lives in Seattle",
      "I'm a product designer at a small studio",
    ]);
  });
});

describe("transcript handling", () => {
  it("parses Deepgram utterances and falls back to diarized words", () => {
    const fromUtterances = parseDeepgram({
      results: { channels: [{ alternatives: [{ transcript: "hi there yes" }] }], utterances: [{ speaker: 1, start: 0, end: 1, transcript: "hi there" }, { speaker: 0, start: 1, end: 2, transcript: "yes" }] },
    });
    expect(fromUtterances.utterances).toEqual([
      { speaker: 1, start: 0, end: 1, text: "hi there" },
      { speaker: 0, start: 1, end: 2, text: "yes" },
    ]);
    const fromWords = parseDeepgram({
      results: { channels: [{ alternatives: [{ transcript: "hi there yes", words: [
        { word: "hi", punctuated_word: "Hi", start: 0, end: 0.2, speaker: 0 },
        { word: "there", punctuated_word: "there", start: 0.2, end: 0.5, speaker: 0 },
        { word: "yes", punctuated_word: "Yes", start: 0.6, end: 0.8, speaker: 1 },
      ] }] }] },
    });
    expect(fromWords.utterances.map((u) => [u.speaker, u.text])).toEqual([[0, "Hi there"], [1, "Yes"]]);
  });

  it("picks the dominant speaker unless pinned", () => {
    const u = [
      { speaker: 0, start: 0, end: 1, text: "one two" },
      { speaker: 1, start: 1, end: 2, text: "one two three four five" },
    ];
    expect(pickOwnerSpeaker(u)).toBe(1);
    expect(pickOwnerSpeaker(u, 0)).toBe(0);
  });
});

describe("training pipeline", () => {
  it("transcribes audio, separates the owner's speaker, learns style and queues facts for review", async () => {
    const ctx = makeCtx();
    const conversation = [
      "Speaker 1: Hey how did the trip go?",
      ...OWNER_LINES.slice(0, 4).map((l) => `Speaker 0: ${l}`),
      "Speaker 1: Sounds nice.",
      ...OWNER_LINES.slice(4).map((l) => `Speaker 0: ${l}`),
    ].join("\n");
    addMedia(ctx, "call.wav", conversation, "audio");
    addMedia(ctx, "notes.txt", "I work as a product designer.\n\nHonestly it's the best job.", "text");

    const job = await runTraining(deps(ctx));
    expect(job.status).toBe("done");
    expect(job.processedMedia).toBe(2);
    expect(ctx.store.data.transcripts).toHaveLength(1);
    expect(ctx.store.data.transcripts[0]!.ownerSpeaker).toBe(0);

    const style = ctx.store.data.style!;
    expect(style.sampleCount).toBe(OWNER_LINES.length + 2);
    expect(style.examples.join(" ")).not.toContain("how did the trip go");
    expect(style.signaturePhrases).toContain("no worries at all");

    const facts = ctx.store.data.facts;
    expect(facts.length).toBeGreaterThanOrEqual(3);
    expect(facts.every((f) => f.status === "pending")).toBe(true);
    expect(facts.map((f) => f.text)).toContain("I work as a product designer");
  });

  it("is idempotent: unchanged media are not re-transcribed and facts are not duplicated", async () => {
    const ctx = makeCtx();
    addMedia(ctx, "call.wav", OWNER_LINES.join("\n"), "audio");
    await runTraining(deps(ctx));
    const factCount = ctx.store.data.facts.length;
    const second = await runTraining(deps(ctx));
    expect(second.processedMedia).toBe(0);
    expect(second.newFacts).toBe(0);
    expect(ctx.store.data.facts).toHaveLength(factCount);
    const forced = await runTraining(deps(ctx), { force: true });
    expect(forced.processedMedia).toBe(1);
    expect(ctx.store.data.facts).toHaveLength(factCount);
  });

  it("records per-file failures without aborting the run", async () => {
    const ctx = makeCtx();
    addMedia(ctx, "good.wav", OWNER_LINES.join("\n"), "audio");
    addMedia(ctx, "bad.wav", "x", "audio");
    const original = ctx.vendors.deepgram.transcribe.bind(ctx.vendors.deepgram);
    ctx.vendors.deepgram.transcribe = async (f) => {
      if (f.filename === "bad.wav") throw new Error("deepgram 400: corrupt audio");
      return original(f);
    };
    const job = await runTraining(deps(ctx));
    expect(job.status).toBe("done");
    expect(job.processedMedia).toBe(1);
    expect(ctx.store.data.media.find((m) => m.filename === "bad.wav")!.error).toMatch(/corrupt/);
    expect(ctx.store.data.style).not.toBeNull();
  });

  it("ignores voice-clone-only, replica and consent media", async () => {
    const ctx = makeCtx();
    addMedia(ctx, "face.mp4", "x", "video", "replica");
    addMedia(ctx, "consent.mp4", "x", "video", "consent");
    const job = await runTraining(deps(ctx));
    expect(job.processedMedia).toBe(0);
    expect(ctx.store.data.style).toBeNull();
  });

  it("uses the LLM for facts and voice description when a real LLM is configured", async () => {
    const llm = new RecordingLlm(() => JSON.stringify({ facts: ["I grew up in Portland", "I love hiking"], voiceDescription: "You are warm and wry." }));
    Object.defineProperty(llm, "mock", { value: false });
    const ctx = makeCtx({}, { llm });
    addMedia(ctx, "call.wav", OWNER_LINES.join("\n"), "audio");
    await runTraining(deps(ctx));
    expect(ctx.store.data.style!.voiceDescription).toBe("You are warm and wry.");
    expect(ctx.store.data.facts.map((f) => f.text)).toEqual(["I grew up in Portland", "I love hiking"]);
  });

  it("falls back to heuristics when the LLM returns junk", async () => {
    const llm = new RecordingLlm(() => "not json");
    Object.defineProperty(llm, "mock", { value: false });
    const ctx = makeCtx({}, { llm });
    addMedia(ctx, "call.wav", OWNER_LINES.join("\n"), "audio");
    const job = await runTraining(deps(ctx));
    expect(job.status).toBe("done");
    expect(ctx.store.data.facts.length).toBeGreaterThan(0);
  });

  it("honors a pinned owner speaker", async () => {
    const ctx = makeCtx();
    addMedia(ctx, "call.wav", ["Speaker 0: I am the interviewer and I talk a lot about many different things today.", "Speaker 1: I love hiking."].join("\n"), "audio", "training", { ownerSpeaker: 1 });
    await runTraining(deps(ctx));
    expect(collectOwnerUtterances(deps(ctx))).toEqual(["I love hiking."]);
  });

  it("refresh makes the persona sound like the owner: approved facts and style reach the prompt", async () => {
    const ctx = makeCtx();
    addMedia(ctx, "call.wav", OWNER_LINES.join("\n"), "audio");
    await runTraining(deps(ctx));
    const fact = ctx.store.data.facts.find((f) => f.text.includes("Portland"))!;
    const before = buildSystemPrompt({ ...ctx.store.data, person: null, memory: null });
    expect(before).not.toContain("Other things that are true about you");
    expect(before).toContain("no worries at all");

    const owner = await ownerToken(ctx);
    await ctx.api.patch(`/api/owner/facts/${fact.id}`).set(bearer(owner)).send({ status: "approved" });
    const after = buildSystemPrompt({ ...ctx.store.data, person: null, memory: null });
    expect(after).toContain("Other things that are true about you");
    expect(after).toContain(`- ${fact.text}`);
  });

  it("runs from the owner API as a single-flight background job", async () => {
    const ctx = makeCtx();
    addMedia(ctx, "call.wav", OWNER_LINES.join("\n"), "audio");
    const original = ctx.vendors.deepgram.transcribe.bind(ctx.vendors.deepgram);
    ctx.vendors.deepgram.transcribe = async (f) => {
      await new Promise((r) => setTimeout(r, 100));
      return original(f);
    };
    const owner = await ownerToken(ctx);
    const first = await ctx.api.post("/api/owner/training/run").set(bearer(owner)).send({});
    expect(first.status).toBe(202);
    const second = await ctx.api.post("/api/owner/training/run").set(bearer(owner)).send({});
    expect(second.status).toBe(409);
    await startTraining(deps(ctx)).done;
    const jobs = await ctx.api.get("/api/owner/training/jobs").set(bearer(owner));
    expect(jobs.body.jobs[0].status).toBe("done");
    const style = await ctx.api.get("/api/owner/style").set(bearer(owner));
    expect(style.body.style.sampleCount).toBe(OWNER_LINES.length);
  });
});
