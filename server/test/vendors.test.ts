import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RealDeepgram } from "../src/vendors/deepgram.js";
import { RealElevenLabs } from "../src/vendors/elevenlabs.js";
import { OpenAiCompatibleLlm } from "../src/vendors/llm.js";
import { RealTavus } from "../src/vendors/tavus.js";
import { VendorError } from "../src/vendors/types.js";
import { formatReport, measureLatency, percentile, summarize } from "../src/scripts/measureLatency.js";

interface Seen {
  url: string;
  init: RequestInit;
}

function fakeFetch(responder: (url: string, init: RequestInit) => Response | object) {
  const seen: Seen[] = [];
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    seen.push({ url: String(url), init });
    const r = responder(String(url), init);
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, seen };
}

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

describe("Tavus client (documented REST shapes)", () => {
  it("creates a conversation with persona, replica, memory store tag and limits", async () => {
    const { impl, seen } = fakeFetch(() => ({ conversation_id: "c1", conversation_url: "https://tavus.daily.co/c1" }));
    const out = await new RealTavus("tvs_key", impl).createConversation({
      replicaId: "r1", personaId: "p1", conversationName: "n", conversationalContext: "ctx",
      customGreeting: "hi", participantTag: "p_per_1", maxCallSeconds: 900, callbackUrl: "https://x/hook",
    });
    expect(out).toEqual({ conversationId: "c1", conversationUrl: "https://tavus.daily.co/c1" });
    expect(seen[0]!.url).toBe("https://tavusapi.com/v2/conversations");
    expect(headersOf(seen[0]!.init)["x-api-key"]).toBe("tvs_key");
    const body = JSON.parse(seen[0]!.init.body as string);
    expect(body).toMatchObject({
      replica_id: "r1", persona_id: "p1", conversational_context: "ctx", custom_greeting: "hi",
      memory_stores: ["p_per_1"], callback_url: "https://x/hook", properties: { max_call_duration: 900 },
    });
  });

  it("ends conversations, creates personas with custom LLM + ElevenLabs TTS, and replicas with consent", async () => {
    const { impl, seen } = fakeFetch((url) =>
      url.endsWith("/personas") ? { persona_id: "pp" } : url.endsWith("/replicas") ? { replica_id: "rr", status: "started" } : {},
    );
    const tavus = new RealTavus("k", impl);
    await tavus.endConversation("c 1");
    expect(seen[0]!.url).toBe("https://tavusapi.com/v2/conversations/c%201/end");

    const persona = await tavus.createPersona({
      name: "Sam", systemPrompt: "s", replicaId: "r1", llmBaseUrl: "https://api/v1", llmApiKey: "shared",
      llmModel: "cloneme-persona", elevenLabsVoiceId: "v1", elevenLabsApiKey: "el",
    });
    expect(persona.personaId).toBe("pp");
    expect(JSON.parse(seen[1]!.init.body as string)).toMatchObject({
      pipeline_mode: "full", default_replica_id: "r1",
      layers: { llm: { base_url: "https://api/v1", api_key: "shared" }, tts: { tts_engine: "elevenlabs", external_voice_id: "v1" } },
    });

    const replica = await tavus.createReplica({ name: "Sam", trainVideoUrl: "https://a/t.mp4", consentVideoUrl: "https://a/c.mp4" });
    expect(replica).toEqual({ replicaId: "rr", status: "started" });
    expect(JSON.parse(seen[2]!.init.body as string)).toMatchObject({ train_video_url: "https://a/t.mp4", consent_video_url: "https://a/c.mp4" });
  });

  it("wraps HTTP errors in VendorError", async () => {
    const { impl } = fakeFetch(() => new Response("bad key", { status: 401 }));
    await expect(new RealTavus("k", impl).endConversation("c")).rejects.toBeInstanceOf(VendorError);
  });
});

describe("ElevenLabs client", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "el-"));
  const sample = path.join(dir, "a.wav");
  writeFileSync(sample, "audio");

  it("runs the PVC create, samples, train flow with the xi-api-key header", async () => {
    const { impl, seen } = fakeFetch((url) => (url.endsWith("/voices/pvc") ? { voice_id: "v1" } : url.endsWith("/samples") ? [{ sample_id: "s1" }] : {}));
    const el = new RealElevenLabs("el_key", impl);
    expect(await el.createPvcVoice({ name: "Sam" })).toEqual({ voiceId: "v1" });
    expect(await el.addPvcSamples("v1", [{ path: sample, filename: "a.wav" }])).toEqual({ sampleIds: ["s1"] });
    await el.startPvcTraining("v1");
    expect(seen.map((s) => s.url)).toEqual([
      "https://api.elevenlabs.io/v1/voices/pvc",
      "https://api.elevenlabs.io/v1/voices/pvc/v1/samples",
      "https://api.elevenlabs.io/v1/voices/pvc/v1/train",
    ]);
    expect(headersOf(seen[0]!.init)["xi-api-key"]).toBe("el_key");
    expect(seen[1]!.init.body).toBeInstanceOf(FormData);
  });

  it("maps fine-tuning state to a status", async () => {
    const status = async (ft: unknown) => (await new RealElevenLabs("k", fakeFetch(() => ({ fine_tuning: ft })).impl).getVoiceStatus("v")).status;
    expect(await status({ state: { eleven_multilingual_v2: "fine_tuned" } })).toBe("ready");
    expect(await status({ state: { eleven_multilingual_v2: "fine_tuning" } })).toBe("training");
    expect(await status({ state: {}, is_allowed_to_fine_tune: false })).toBe("needs_verification");
    expect(await status({ state: {}, is_allowed_to_fine_tune: true })).toBe("created");
  });

  it("measures time to first audio byte", async () => {
    const { impl } = fakeFetch(() => new Response(new Blob([new Uint8Array(10)]), { status: 200 }));
    expect(await new RealElevenLabs("k", impl).ttsFirstByteMs("v", "hi")).toBeGreaterThanOrEqual(0);
  });
});

describe("Deepgram client", () => {
  it("requests Nova-3 with diarization and parses the response", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dg-"));
    const file = path.join(dir, "a.wav");
    writeFileSync(file, "audio");
    const { impl, seen } = fakeFetch(() => ({
      results: { channels: [{ alternatives: [{ transcript: "hello" }] }], utterances: [{ speaker: 0, start: 0, end: 1, transcript: "hello" }] },
    }));
    const out = await new RealDeepgram("dg_key", impl).transcribe({ path: file, filename: "a.wav", mimeType: "audio/wav" });
    const url = new URL(seen[0]!.url);
    expect(url.pathname).toBe("/v1/listen");
    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(url.searchParams.get("diarize")).toBe("true");
    expect(headersOf(seen[0]!.init).authorization).toBe("Token dg_key");
    expect(out.utterances[0]!.text).toBe("hello");
  });
});

describe("OpenAI-compatible LLM client", () => {
  const sse = (...parts: string[]) =>
    new Response(parts.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join("") + "data: [DONE]\n\n", { status: 200 });

  it("parses streamed deltas", async () => {
    const { impl, seen } = fakeFetch(() => sse("Hel", "lo"));
    const llm = new OpenAiCompatibleLlm("sk", "https://llm.test/v1", "m", impl);
    let out = "";
    for await (const d of llm.stream([{ role: "user", content: "hi" }])) out += d;
    expect(out).toBe("Hello");
    expect(headersOf(seen[0]!.init).authorization).toBe("Bearer sk");
    expect(JSON.parse(seen[0]!.init.body as string)).toMatchObject({ model: "m", stream: true });
  });

  it("completes with JSON mode", async () => {
    const { impl, seen } = fakeFetch(() => ({ choices: [{ message: { content: "{\"a\":1}" } }] }));
    const llm = new OpenAiCompatibleLlm("sk", "https://llm.test/v1", "m", impl);
    expect(await llm.complete([{ role: "user", content: "x" }], { json: true })).toBe('{"a":1}');
    expect(JSON.parse(seen[0]!.init.body as string).response_format).toEqual({ type: "json_object" });
  });
});

describe("latency script", () => {
  it("computes percentiles", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
    expect(summarize([10, 20, 30])).toMatchObject({ n: 3, p50: 20, max: 30 });
  });

  it("measures an in-process mock stack end to end", async () => {
    const report = await measureLatency({ runs: 3, json: false });
    expect(report.sessionCreateMs.n).toBe(3);
    expect(report.personaFirstTokenMs?.n).toBe(3);
    expect(report.estimatedReplyStartMs).not.toBeNull();
    expect(formatReport(report)).toContain("mock mode");
  });
});
