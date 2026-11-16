import path from "node:path";
import type { Config } from "./config.js";
import { mediaDirOf, signedMediaUrl } from "./media.js";
import type { Store } from "./store.js";
import type { Vendors } from "./vendors/types.js";

export interface SetupDeps {
  config: Config;
  store: Store;
  vendors: Vendors;
}

export class SetupError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Env vars win over values the setup scripts saved, so a deploy can pin ids. */
export function effectiveIds(config: Config, store: Store) {
  const v = store.data.vendor;
  return {
    voiceId: config.vendors.elevenlabs.voiceId ?? v.voiceId,
    replicaId: config.vendors.tavus.replicaId ?? v.replicaId,
    personaId: config.vendors.tavus.personaId ?? v.personaId,
  };
}

export async function setupVoice({ config, store, vendors }: SetupDeps, opts: { name?: string } = {}) {
  const samples = store.data.media.filter((m) => m.kind === "audio" && m.purpose === "voice");
  if (!samples.length) throw new SetupError("no_voice_samples", "Upload clean speech audio with purpose=voice first (30+ minutes recommended).");
  const files = samples.map((m) => ({ path: path.join(mediaDirOf(config), m.storedAs), filename: m.filename }));
  const name = opts.name ?? `${store.data.profile.displayName} (cloneME)`;
  const { voiceId } = await vendors.elevenlabs.createPvcVoice({ name, description: "cloneME professional voice clone" });
  await vendors.elevenlabs.addPvcSamples(voiceId, files);
  store.update((db) => {
    db.vendor.voiceId = voiceId;
    db.vendor.voiceStatus = "samples_uploaded";
  });
  // Training needs ElevenLabs voice verification to be completed first; report instead of failing the whole setup.
  let note: string | undefined;
  try {
    await vendors.elevenlabs.startPvcTraining(voiceId);
    store.update((db) => {
      db.vendor.voiceStatus = "training";
    });
  } catch (err) {
    store.update((db) => {
      db.vendor.voiceStatus = "needs_verification";
    });
    note = `Samples uploaded, but training did not start (${(err as Error).message}). Complete voice verification in the ElevenLabs dashboard, then run setup-voice --train.`;
  }
  return { voiceId, samples: files.length, note };
}

export async function trainVoice({ store, vendors, config }: SetupDeps) {
  const voiceId = effectiveIds(config, store).voiceId;
  if (!voiceId) throw new SetupError("no_voice", "No voice clone exists yet; run setup-voice first.");
  await vendors.elevenlabs.startPvcTraining(voiceId);
  store.update((db) => {
    db.vendor.voiceStatus = "training";
  });
  return { voiceId };
}

export async function setupReplica({ config, store, vendors }: SetupDeps, opts: { name?: string } = {}) {
  const pick = (purpose: "replica" | "consent") =>
    [...store.data.media].reverse().find((m) => m.kind === "video" && m.purpose === purpose);
  const train = pick("replica");
  const consent = pick("consent");
  if (!train) throw new SetupError("no_training_video", "Upload about 2 minutes of clean on-camera video with purpose=replica.");
  if (!consent) throw new SetupError("no_consent_video", "Upload the spoken consent video with purpose=consent. Tavus requires it for personal replicas.");
  const { replicaId, status } = await vendors.tavus.createReplica({
    name: opts.name ?? `${store.data.profile.displayName} (cloneME)`,
    trainVideoUrl: signedMediaUrl(config, train.id, 6 * 3600),
    consentVideoUrl: signedMediaUrl(config, consent.id, 6 * 3600),
    callbackUrl: config.tavusWebhookSecret
      ? `${config.publicBaseUrl}/webhooks/tavus?secret=${encodeURIComponent(config.tavusWebhookSecret)}`
      : undefined,
  });
  store.update((db) => {
    db.vendor.replicaId = replicaId;
    db.vendor.replicaStatus = status;
  });
  return { replicaId, status };
}

/** Creates the Tavus persona: our persona service as the LLM, the ElevenLabs clone as the voice. */
export async function setupPersona({ config, store, vendors }: SetupDeps) {
  const ids = effectiveIds(config, store);
  if (!ids.replicaId) throw new SetupError("no_replica", "Create the Tavus replica first (setup-replica).");
  if (!ids.voiceId) throw new SetupError("no_voice", "Create the ElevenLabs voice clone first (setup-voice).");
  const name = store.data.profile.displayName;
  const { personaId } = await vendors.tavus.createPersona({
    name: `${name} (cloneME)`,
    systemPrompt: `You are the AI version of ${name}. The real instructions come from the custom LLM.`,
    replicaId: ids.replicaId,
    llmBaseUrl: `${config.publicBaseUrl}/v1`,
    llmApiKey: config.personaSharedSecret,
    llmModel: "cloneme-persona",
    elevenLabsVoiceId: ids.voiceId,
    elevenLabsApiKey: config.vendors.elevenlabs.apiKey ?? "mock-elevenlabs-key",
  });
  store.update((db) => {
    db.vendor.personaId = personaId;
  });
  return { personaId };
}

export async function syncVendorStatus({ config, store, vendors }: SetupDeps) {
  const ids = effectiveIds(config, store);
  if (ids.voiceId) {
    const { status } = await vendors.elevenlabs.getVoiceStatus(ids.voiceId);
    store.update((db) => {
      db.vendor.voiceStatus = status;
    });
  }
  if (ids.replicaId) {
    const { status } = await vendors.tavus.getReplica(ids.replicaId);
    store.update((db) => {
      db.vendor.replicaStatus = status;
    });
  }
  return vendorStatus({ config, store });
}

export function vendorStatus({ config, store }: Pick<SetupDeps, "config" | "store">) {
  const v = config.vendors;
  const ids = effectiveIds(config, store);
  return {
    mode: {
      tavus: v.tavus.mock ? "mock" : "live",
      elevenlabs: v.elevenlabs.mock ? "mock" : "live",
      deepgram: v.deepgram.mock ? "mock" : "live",
      llm: v.llm.mock ? "mock" : "live",
    },
    voice: { id: ids.voiceId ?? null, status: store.data.vendor.voiceStatus ?? "none" },
    replica: { id: ids.replicaId ?? null, status: store.data.vendor.replicaStatus ?? "none" },
    persona: { id: ids.personaId ?? null },
    readyForCalls: Boolean(ids.replicaId && ids.personaId),
  };
}
