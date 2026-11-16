import type { Config } from "../config.js";
import { MockDeepgram, RealDeepgram } from "./deepgram.js";
import { MockElevenLabs, RealElevenLabs } from "./elevenlabs.js";
import { MockLlm, OpenAiCompatibleLlm } from "./llm.js";
import { MockTavus, RealTavus } from "./tavus.js";
import type { Vendors } from "./types.js";

/**
 * Clients are rebuilt lazily whenever the keys in `config.vendors` change (the owner can paste keys in the app
 * while the server is running), so callers must read `vendors.tavus` etc. at use time, not cache them.
 */
export function createVendors(config: Config): Vendors {
  const cache = new Map<string, { sig: string; client: unknown }>();
  const get = <T>(name: string, sig: string, make: () => T): T => {
    const hit = cache.get(name);
    if (hit && hit.sig === sig) return hit.client as T;
    const client = make();
    cache.set(name, { sig, client });
    return client;
  };
  const v = config.vendors;
  return {
    get tavus() {
      return get("tavus", `${v.tavus.mock}|${v.tavus.apiKey}`, () => (v.tavus.mock ? new MockTavus() : new RealTavus(v.tavus.apiKey!)));
    },
    get elevenlabs() {
      return get("elevenlabs", `${v.elevenlabs.mock}|${v.elevenlabs.apiKey}`, () =>
        v.elevenlabs.mock ? new MockElevenLabs({ requireVerification: config.mockRequireVerification }) : new RealElevenLabs(v.elevenlabs.apiKey!),
      );
    },
    get deepgram() {
      return get("deepgram", `${v.deepgram.mock}|${v.deepgram.apiKey}`, () => (v.deepgram.mock ? new MockDeepgram() : new RealDeepgram(v.deepgram.apiKey!)));
    },
    get llm() {
      return get("llm", `${v.llm.mock}|${v.llm.apiKey}|${v.llm.baseUrl}|${v.llm.model}`, () =>
        v.llm.mock ? new MockLlm() : new OpenAiCompatibleLlm(v.llm.apiKey!, v.llm.baseUrl, v.llm.model),
      );
    },
  };
}

export * from "./types.js";
