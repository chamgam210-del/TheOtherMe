import { randomBytes } from "node:crypto";
import path from "node:path";

export interface Config {
  port: number;
  publicBaseUrl: string;
  dataDir: string;
  sessionSecret: string;
  ownerName: string;
  ownerInviteCode?: string;
  /** One-time token that lets the first person claim an unclaimed server (set by the deploy template). */
  setupToken?: string;
  sessionSecretFromEnv: boolean;
  personaSecretFromEnv: boolean;
  persistentStorage: boolean;
  installerUrl: string;
  forceMock: boolean;
  mockRequireVerification: boolean;
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
  // Missing secrets are generated and persisted on first start (see ensureInstanceSecrets), so a
  // non-technical owner never has to invent them. Short values are rejected because they are guessable.
  const sessionSecret = env.SESSION_SECRET || "";
  if (sessionSecret && sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const personaSharedSecret = env.PERSONA_LLM_SHARED_SECRET || "";
  if (personaSharedSecret && personaSharedSecret.length < 24) throw new Error("PERSONA_LLM_SHARED_SECRET must be at least 24 characters");
  const key = (name: string) => (env[name] && env[name]!.trim() ? env[name]!.trim() : undefined);
  const tavusKey = key("TAVUS_API_KEY");
  const elevenKey = key("ELEVENLABS_API_KEY");
  const deepgramKey = key("DEEPGRAM_API_KEY");
  const llmKey = key("LLM_API_KEY");
  return {
    port,
    publicBaseUrl: (env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/+$/, ""),
    dataDir: path.resolve(env.DATA_DIR || "./data"),
    sessionSecret: sessionSecret || randomBytes(32).toString("hex"),
    ownerName: env.OWNER_NAME || "Owner",
    ownerInviteCode: key("OWNER_INVITE_CODE"),
    setupToken: key("SETUP_TOKEN"),
    sessionSecretFromEnv: Boolean(sessionSecret),
    personaSecretFromEnv: Boolean(personaSharedSecret),
    persistentStorage: truthy(env.PERSISTENT_STORAGE),
    installerUrl: env.INSTALLER_URL || "https://github.com/chamgam210-del/TheOtherMe/releases/latest",
    forceMock,
    mockRequireVerification: truthy(env.MOCK_REQUIRE_VERIFICATION),
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

export type VendorKeys = {
  tavus?: string;
  elevenlabs?: string;
  deepgram?: string;
  llm?: { apiKey?: string; baseUrl?: string; model?: string };
};

/** Applies owner-supplied keys (saved from the app) on top of the environment. Mutates in place so live clients pick them up. */
export function applyVendorKeys(config: Config, keys: VendorKeys): void {
  const v = config.vendors;
  if (keys.tavus) v.tavus.apiKey = keys.tavus;
  if (keys.elevenlabs) v.elevenlabs.apiKey = keys.elevenlabs;
  if (keys.deepgram) v.deepgram.apiKey = keys.deepgram;
  if (keys.llm?.apiKey) v.llm.apiKey = keys.llm.apiKey;
  if (keys.llm?.baseUrl) v.llm.baseUrl = keys.llm.baseUrl.replace(/\/+$/, "");
  if (keys.llm?.model) v.llm.model = keys.llm.model;
  v.tavus.mock = config.forceMock || !v.tavus.apiKey;
  v.elevenlabs.mock = config.forceMock || !v.elevenlabs.apiKey;
  v.deepgram.mock = config.forceMock || !v.deepgram.apiKey;
  v.llm.mock = config.forceMock || !v.llm.apiKey;
}

export function clearVendorKey(config: Config, vendor: "tavus" | "elevenlabs" | "deepgram" | "llm"): void {
  config.vendors[vendor].apiKey = undefined;
  applyVendorKeys(config, {});
}
