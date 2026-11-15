import type { Config } from "../config.js";
import { MockDeepgram, RealDeepgram } from "./deepgram.js";
import { MockElevenLabs, RealElevenLabs } from "./elevenlabs.js";
import { MockLlm, OpenAiCompatibleLlm } from "./llm.js";
import { MockTavus, RealTavus } from "./tavus.js";
import type { Vendors } from "./types.js";

export function createVendors(config: Config): Vendors {
  const v = config.vendors;
  return {
    tavus: v.tavus.mock ? new MockTavus() : new RealTavus(v.tavus.apiKey!),
    elevenlabs: v.elevenlabs.mock ? new MockElevenLabs() : new RealElevenLabs(v.elevenlabs.apiKey!),
    deepgram: v.deepgram.mock ? new MockDeepgram() : new RealDeepgram(v.deepgram.apiKey!),
    llm: v.llm.mock ? new MockLlm() : new OpenAiCompatibleLlm(v.llm.apiKey!, v.llm.baseUrl, v.llm.model),
  };
}

export * from "./types.js";
