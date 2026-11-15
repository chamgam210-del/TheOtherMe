import { randomBytes } from "node:crypto";
import path from "node:path";

export interface Config {
  port: number;
  publicBaseUrl: string;
  dataDir: string;
  sessionSecret: string;
  ownerName: string;
  ownerInviteCode?: string;
  personaSharedSecret: string;
  tavusWebhookSecret: string;
  tokenTtlSeconds: number;
  maxConcurrentSessions: number;
  maxCallSeconds: number;
  maxUploadBytes: number;
  vendors: {
    tavus: { apiKey?: string; replicaId?: string; personaId?: string; mock: boolean };
    elevenlabs: { apiKey?: string; voiceId?: string; mock: boolean };
    deepgram: { apiKey?: string; mock: boolean };
    llm: { apiKey?: string; baseUrl: string; model: string; mock: boolean };
  };
}

type Env = Record<string, string | undefined>;

const truthy = (v: string | undefined) => ["1", "true", "yes"].includes((v ?? "").toLowerCase());
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
};

export function loadConfig(env: Env = process.env): Config {
  const forceMock = truthy(env.MOCK_MODE);
  const port = num(env.PORT, 8787);
  const production = env.NODE_ENV === "production";
  const sessionSecret = env.SESSION_SECRET || "";
  if (production && sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET (>= 32 chars) is required in production");
  }
  const personaSharedSecret = env.PERSONA_LLM_SHARED_SECRET || "";
  if (production && personaSharedSecret.length < 24) {
    throw new Error("PERSONA_LLM_SHARED_SECRET (>= 24 chars) is required in production");
  }
  const key = (name: string) => (env[name] && env[name]!.trim() ? env[name]!.trim() : undefined);
  const tavusKey = key("TAVUS_API_KEY");
  const elevenKey = key("ELEVENLABS_API_KEY");
  const deepgramKey = key("DEEPGRAM_API_KEY");
  const llmKey = key("LLM_API_KEY");
  return {
    port,
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ""),
    dataDir: path.resolve(env.DATA_DIR || "./data"),
    sessionSecret: sessionSecret || randomBytes(32).toString("hex"),
    ownerName: env.OWNER_NAME || "Owner",
    ownerInviteCode: key("OWNER_INVITE_CODE"),
    personaSharedSecret: personaSharedSecret || randomBytes(24).toString("hex"),
    tavusWebhookSecret: env.TAVUS_WEBHOOK_SECRET || "",
    tokenTtlSeconds: num(env.TOKEN_TTL_SECONDS, 60 * 60 * 24 * 30),
    maxConcurrentSessions: num(env.MAX_CONCURRENT_SESSIONS, 3),
    maxCallSeconds: num(env.MAX_CALL_SECONDS, 1800),
    maxUploadBytes: num(env.MAX_UPLOAD_MB, 2048) * 1024 * 1024,
    vendors: {
      tavus: {
        apiKey: tavusKey,
        replicaId: key("TAVUS_REPLICA_ID"),
        personaId: key("TAVUS_PERSONA_ID"),
        mock: forceMock || !tavusKey,
      },
      elevenlabs: { apiKey: elevenKey, voiceId: key("ELEVENLABS_VOICE_ID"), mock: forceMock || !elevenKey },
      deepgram: { apiKey: deepgramKey, mock: forceMock || !deepgramKey },
      llm: {
        apiKey: llmKey,
        baseUrl: (env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
        model: env.LLM_MODEL || "gpt-4o",
        mock: forceMock || !llmKey,
      },
    },
  };
}
