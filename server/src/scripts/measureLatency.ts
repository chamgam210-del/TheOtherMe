import type { AddressInfo } from "node:net";
import { createApp } from "../app.js";
import { addPerson } from "../auth.js";
import { loadConfig } from "../config.js";
import { Store } from "../store.js";
import { createVendors } from "../vendors/index.js";

export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export const summarize = (values: number[]) => ({
  n: values.length,
  p50: Math.round(percentile(values, 50)),
  p95: Math.round(percentile(values, 95)),
  max: Math.round(Math.max(...values)),
});

const PROMPTS = [
  "Hey, how was your day?",
  "Do you remember what we talked about last time?",
  "What's your favorite thing to cook?",
  "Tell me something funny that happened recently.",
  "What are you up to this weekend?",
];

export interface LatencyOptions {
  url?: string;
  code?: string;
  personaSecret?: string;
  runs: number;
  json: boolean;
}

export const AVATAR_VIDEO_DELAY_MS = 150;

async function timedChat(base: string, secret: string, personId: string, prompt: string) {
  const start = performance.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "x-cloneme-person": personId },
    body: JSON.stringify({ model: "cloneme-persona", stream: true, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`persona endpoint returned ${res.status}`);
  let firstToken: number | null = null;
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    const text = decoder.decode(chunk);
    if (firstToken === null && /"content":"[^"]/.test(text)) firstToken = performance.now() - start;
  }
  return { firstToken: firstToken ?? performance.now() - start, total: performance.now() - start };
}

export async function measureLatency(opts: LatencyOptions) {
  let base = opts.url?.replace(/\/+$/, "");
  let close: (() => void) | undefined;
  let code = opts.code;
  let secret = opts.personaSecret ?? process.env.PERSONA_LLM_SHARED_SECRET;
  let ttsProbe: (() => Promise<number>) | null = null;
  let mode = "remote";

  if (!base) {
    const config = loadConfig({ ...process.env, DATA_DIR: "", PORT: "0" });
    const store = new Store(null, config.ownerName);
    const vendors = createVendors(config);
    const ctx = createApp({ config, store, vendors });
    const server = ctx.app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    code = addPerson(store, { name: "Latency Tester", role: "friend" }).code;
    secret = config.personaSharedSecret;
    const voiceId = config.vendors.elevenlabs.voiceId;
    if (voiceId) ttsProbe = () => vendors.elevenlabs.ttsFirstByteMs(voiceId, "Hey, it's really good to see you.");
    mode = ["tavus", "elevenlabs", "llm"].map((k) => `${k}=${(config.vendors as any)[k].mock ? "mock" : "live"}`).join(" ");
  }
  if (!code) throw new Error("--code <invite code> is required when measuring a remote server");

  try {
    const redeem = await fetch(`${base}/api/auth/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!redeem.ok) throw new Error(`invite code rejected (${redeem.status})`);
    const { token, person } = (await redeem.json()) as { token: string; person: { id: string } };
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const sessionMs: number[] = [];
    const ttft: number[] = [];
    const total: number[] = [];
    const tts: number[] = [];
    let textFallbackMs: number[] = [];

    for (let i = 0; i < opts.runs; i++) {
      const t0 = performance.now();
      const created = await fetch(`${base}/api/sessions`, { method: "POST", headers: auth, body: "{}" });
      sessionMs.push(performance.now() - t0);
      if (!created.ok) throw new Error(`session create failed (${created.status})`);
      const { sessionId } = (await created.json()) as { sessionId: string };

      const prompt = PROMPTS[i % PROMPTS.length]!;
      if (secret) {
        const r = await timedChat(base, secret, person.id, prompt);
        ttft.push(r.firstToken);
        total.push(r.total);
      } else {
        const t1 = performance.now();
        await fetch(`${base}/api/sessions/${sessionId}/text`, { method: "POST", headers: auth, body: JSON.stringify({ text: prompt }) });
        textFallbackMs.push(performance.now() - t1);
      }
      if (ttsProbe) tts.push(await ttsProbe());
      await fetch(`${base}/api/sessions/${sessionId}/end`, { method: "POST", headers: auth, body: "{}" });
    }

    const report = {
      target: base,
      mode,
      runs: opts.runs,
      sessionCreateMs: summarize(sessionMs),
      personaFirstTokenMs: ttft.length ? summarize(ttft) : null,
      personaFullReplyMs: total.length ? summarize(total) : null,
      textFallbackMs: textFallbackMs.length ? summarize(textFallbackMs) : null,
      ttsFirstByteMs: tts.length ? summarize(tts) : null,
      estimatedReplyStartMs:
        ttft.length ? Math.round(percentile(ttft, 50) + (tts.length ? percentile(tts, 50) : 150) + AVATAR_VIDEO_DELAY_MS) : null,
      notes: [
        "estimatedReplyStartMs = persona first token + TTS first byte (150 ms assumed when not measured) + 150 ms avatar video delay.",
        "Speech-end detection and STT inside Tavus are not measured here; compare against the real call using the pilot stopwatch method in the README.",
        mode.includes("mock") ? "Some vendors are in mock mode, so these numbers only show backend overhead, not real vendor latency." : "All measured vendors are live.",
      ],
    };
    return report;
  } finally {
    close?.();
  }
}

export function formatReport(r: Awaited<ReturnType<typeof measureLatency>>): string {
  const row = (label: string, s: ReturnType<typeof summarize> | null) =>
    s ? `${label.padEnd(26)} p50 ${String(s.p50).padStart(5)} ms   p95 ${String(s.p95).padStart(5)} ms   max ${String(s.max).padStart(5)} ms   (n=${s.n})` : null;
  return [
    `Target: ${r.target}   [${r.mode}]`,
    row("session create", r.sessionCreateMs),
    row("persona first token", r.personaFirstTokenMs),
    row("persona full reply", r.personaFullReplyMs),
    row("text fallback reply", r.textFallbackMs),
    row("ElevenLabs first byte", r.ttsFirstByteMs),
    r.estimatedReplyStartMs !== null ? `Estimated time until the clone starts replying: ~${r.estimatedReplyStartMs} ms (target 750-1000 ms)` : null,
    ...r.notes.map((n) => `Note: ${n}`),
  ]
    .filter(Boolean)
    .join("\n");
}
