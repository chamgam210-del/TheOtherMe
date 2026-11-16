import type { FetchLike } from "./types.js";

export type VendorId = "tavus" | "elevenlabs" | "deepgram" | "llm";

export interface KeyVerification {
  ok: boolean;
  message: string;
  /** Non-blocking advice, e.g. the plan lacks a feature we need later. */
  warning?: string;
}

const fail = (message: string): KeyVerification => ({ ok: false, message });

async function probe(fetchImpl: FetchLike, url: string, init: RequestInit) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15000) });
  } catch {
    return null;
  }
}

function judge(vendor: string, res: Response | null): KeyVerification | null {
  if (!res) return fail(`Could not reach ${vendor}. Check the internet connection of your server and try again.`);
  if (res.status === 401 || res.status === 403) return fail(`${vendor} rejected this key. Copy it again from the ${vendor} dashboard (no spaces) and check it is enabled.`);
  if (res.status === 429) return { ok: true, message: `${vendor} key accepted (rate limited right now).` };
  if (!res.ok) return fail(`${vendor} returned an unexpected error (${res.status}). Try again in a minute.`);
  return null;
}

export async function verifyTavus(fetchImpl: FetchLike, key: string): Promise<KeyVerification> {
  const res = await probe(fetchImpl, "https://tavusapi.com/v2/replicas?limit=1", { headers: { "x-api-key": key } });
  return judge("Tavus", res) ?? { ok: true, message: "Tavus key works." };
}

export async function verifyElevenLabs(fetchImpl: FetchLike, key: string): Promise<KeyVerification> {
  const res = await probe(fetchImpl, "https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": key } });
  const bad = judge("ElevenLabs", res);
  if (bad) return bad;
  const body = (await res!.json().catch(() => ({}))) as Record<string, unknown>;
  const result: KeyVerification = { ok: true, message: "ElevenLabs key works." };
  if (body.can_use_professional_voice_cloning === false) {
    result.warning = "This ElevenLabs plan does not include Professional Voice Cloning. Upgrade to a plan that does (Creator or higher) before building your voice.";
  }
  return result;
}

export async function verifyDeepgram(fetchImpl: FetchLike, key: string): Promise<KeyVerification> {
  const res = await probe(fetchImpl, "https://api.deepgram.com/v1/projects", { headers: { authorization: `Token ${key}` } });
  return judge("Deepgram", res) ?? { ok: true, message: "Deepgram key works." };
}

export async function verifyLlm(fetchImpl: FetchLike, key: string, baseUrl: string, model: string): Promise<KeyVerification> {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${key}` };
  const models = await probe(fetchImpl, `${base}/models`, { headers });
  if (models && (models.status === 404 || models.status === 405)) {
    const chat = await probe(fetchImpl, `${base}/chat/completions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
    });
    return judge("Your LLM provider", chat) ?? { ok: true, message: "LLM key works." };
  }
  return judge("Your LLM provider", models) ?? { ok: true, message: "LLM key works." };
}

export async function verifyVendorKey(
  vendor: VendorId,
  fetchImpl: FetchLike,
  key: string,
  llm: { baseUrl: string; model: string },
): Promise<KeyVerification> {
  switch (vendor) {
    case "tavus":
      return verifyTavus(fetchImpl, key);
    case "elevenlabs":
      return verifyElevenLabs(fetchImpl, key);
    case "deepgram":
      return verifyDeepgram(fetchImpl, key);
    case "llm":
      return verifyLlm(fetchImpl, key, llm.baseUrl, llm.model);
  }
}
