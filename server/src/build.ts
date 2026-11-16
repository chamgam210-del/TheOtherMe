import type { Config } from "./config.js";
import { mediaDirOf } from "./media.js";
import { effectiveIds, setupPersona, setupReplica, setupVoice, trainVoice, type SetupDeps } from "./setup.js";
import type { StageStatus, Store } from "./store.js";
import { startTraining } from "./training/pipeline.js";

export const STAGES = ["transcription", "voice", "voiceVerification", "replica", "persona"] as const;
export type StageId = (typeof STAGES)[number];

export interface Stage {
  id: StageId;
  label: string;
  status: StageStatus;
  detail: string;
}

export interface BuildStatus {
  started: boolean;
  ready: boolean;
  stages: Stage[];
  /** Present while waiting for the owner to do something outside the app. */
  manualAction: null | { id: "elevenlabs-verification"; title: string; steps: string[]; link: string };
  mock: boolean;
}

const SYNC_INTERVAL_MS = 8000;
const locks = new WeakMap<Store, Promise<unknown>>();

async function exclusive<T>(store: Store, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(store) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(store, next);
  return next;
}

const VERIFICATION_STEPS = [
  "Open elevenlabs.io and go to Voices, then open the voice named after you (it says Professional Voice Clone).",
  "Choose Verify voice. ElevenLabs shows a short text: read it aloud into your microphone exactly as written, from the same account or device you recorded on.",
  "Wait for ElevenLabs to confirm the voice is verified (usually a few minutes; sometimes it asks for manual review).",
  "Come back here and press \"I've verified my voice\". The app will start voice training.",
];

function stageList(config: Config, store: Store): Stage[] {
  const db = store.data;
  const v = db.vendor;
  const ids = effectiveIds(config, store);
  const started = Boolean(db.build.startedAt);
  const errors = db.build.errors;
  const lastJob = db.jobs[db.jobs.length - 1];
  const trainable = db.media.filter((m) => (m.kind === "audio" || m.kind === "video") && (m.purpose === "training" || m.purpose === "voice") && m.promptKind !== "reading");
  const pending = trainable.filter((m) => !m.processedAt && !m.error);

  const transcription: Stage = { id: "transcription", label: "Learn how you talk", status: "pending", detail: "Waiting to start." };
  if (started) {
    if (lastJob?.status === "running") Object.assign(transcription, { status: "running", detail: "Transcribing your recordings and learning your style…" });
    else if (errors.transcription || lastJob?.status === "failed") Object.assign(transcription, { status: "failed", detail: errors.transcription ?? lastJob?.error ?? "Transcription failed." });
    else if (pending.length) Object.assign(transcription, { status: "running", detail: `${pending.length} recording(s) waiting to be transcribed.` });
    else if (lastJob?.status === "done") {
      const failed = trainable.filter((m) => m.error).length;
      Object.assign(transcription, { status: "done", detail: failed ? `Done, but ${failed} file(s) could not be read.` : `Learned from ${db.transcripts.length} recording(s); ${db.facts.length} fact(s) to review.` });
    } else Object.assign(transcription, { status: "done", detail: "No story recordings to learn from yet. You can refresh later." });
  }

  const voice: Stage = { id: "voice", label: "Clone your voice", status: "pending", detail: "Waiting to start." };
  const verification: Stage = { id: "voiceVerification", label: "Verify your voice with ElevenLabs", status: "pending", detail: "Needed once, so nobody can clone a voice that isn't theirs." };
  if (started) {
    if (errors.voice) Object.assign(voice, { status: "failed", detail: errors.voice });
    else if (!ids.voiceId) Object.assign(voice, { status: "running", detail: "Uploading your voice samples…" });
    else if (v.voiceStatus === "ready") Object.assign(voice, { status: "done", detail: "Your voice clone is ready." });
    else if (v.voiceStatus === "training") Object.assign(voice, { status: "running", detail: "ElevenLabs is training your voice. This usually takes a few hours; you can close the app and come back." });
    else if (v.voiceStatus === "error") Object.assign(voice, { status: "failed", detail: "ElevenLabs reported a training error. Check the voice in your ElevenLabs dashboard." });
    else Object.assign(voice, { status: "waiting", detail: "Samples uploaded. Waiting for verification before training can start." });

    if (v.voiceStatus === "ready" || v.voiceStatus === "training") Object.assign(verification, { status: "done", detail: "Verified." });
    else if (v.voiceStatus === "needs_verification" || v.voiceStatus === "samples_uploaded") Object.assign(verification, { status: "waiting", detail: "Your action is needed (instructions below)." });
  }

  const replica: Stage = { id: "replica", label: "Build your face replica", status: "pending", detail: "Waiting to start." };
  if (started) {
    if (errors.replica) Object.assign(replica, { status: "failed", detail: errors.replica });
    else if (!ids.replicaId) Object.assign(replica, { status: "running", detail: "Sending your training video to Tavus…" });
    else if (["completed", "ready"].includes(v.replicaStatus ?? "")) Object.assign(replica, { status: "done", detail: "Your face replica is ready." });
    else if (["error", "failed"].includes(v.replicaStatus ?? "")) Object.assign(replica, { status: "failed", detail: "Tavus could not build the replica. Re-record the training video and consent video, then rebuild." });
    else Object.assign(replica, { status: "running", detail: "Tavus is training your replica. This can take a while; you can close the app and come back." });
  }

  const persona: Stage = { id: "persona", label: "Connect your AI self", status: "pending", detail: "Starts after voice and face are ready." };
  if (started) {
    if (errors.persona) Object.assign(persona, { status: "failed", detail: errors.persona });
    else if (ids.personaId) Object.assign(persona, { status: "done", detail: "Connected." });
    else if (voice.status === "done" && replica.status === "done") Object.assign(persona, { status: "running", detail: "Linking voice, face and brain…" });
  }
  return [transcription, voice, verification, replica, persona];
}

export function buildStatus(config: Config, store: Store): BuildStatus {
  const stages = stageList(config, store);
  const verification = stages.find((s) => s.id === "voiceVerification")!;
  return {
    started: Boolean(store.data.build.startedAt),
    ready: stages.every((s) => s.status === "done"),
    stages,
    manualAction:
      verification.status === "waiting"
        ? { id: "elevenlabs-verification", title: "Verify your voice in ElevenLabs", steps: VERIFICATION_STEPS, link: "https://elevenlabs.io/app/voice-lab" }
        : null,
    mock: config.vendors.tavus.mock && config.vendors.elevenlabs.mock,
  };
}

export class BuildPreconditionError extends Error {}

function preconditions(config: Config, store: Store) {
  const media = store.data.media;
  const voice = media.filter((m) => m.purpose === "voice" && m.kind === "audio");
  const missing: string[] = [];
  if (!voice.length) missing.push("voice recordings (step 4)");
  if (!media.some((m) => m.purpose === "replica" && m.kind === "video")) missing.push("the on-camera training video (step 5)");
  if (!media.some((m) => m.purpose === "consent" && m.kind === "video")) missing.push("the consent video (step 6)");
  if (missing.length) throw new BuildPreconditionError(`Still needed: ${missing.join(", ")}.`);
}

/** Moves every stage that can move; safe to call repeatedly (it is how the app polls). */
export async function advanceBuild(deps: SetupDeps, opts: { start?: boolean; sync?: boolean } = {}): Promise<BuildStatus> {
  const { config, store, vendors } = deps;
  if (opts.start && !store.data.build.startedAt) {
    preconditions(config, store);
    store.update((db) => {
      db.build.startedAt = new Date().toISOString();
      db.build.errors = {};
    });
  }
  if (!store.data.build.startedAt) return buildStatus(config, store);

  await exclusive(store, async () => {
    const db = store.data;
    const ids = () => effectiveIds(config, store);
    const fail = (stage: string, err: unknown) =>
      store.update(() => {
        db.build.errors[stage] = (err as Error).message;
      });

    // Transcription and style learning.
    if (!db.jobs.some((j) => j.status === "running")) {
      const needs = db.media.some((m) => (m.kind === "audio" || m.kind === "video") && (m.purpose === "training" || m.purpose === "voice") && m.promptKind !== "reading" && !m.processedAt && !m.error);
      if (needs || (!db.jobs.length && opts.start)) {
        startTraining({ store, vendors, mediaDir: mediaDirOf(config) });
      }
    }

    if (!ids().voiceId && !db.build.errors.voice) {
      try {
        await setupVoice(deps);
      } catch (err) {
        fail("voice", err);
      }
    }
    if (!ids().replicaId && !db.build.errors.replica) {
      try {
        await setupReplica(deps);
      } catch (err) {
        fail("replica", err);
      }
    }

    const due = opts.sync || !db.build.lastSyncAt || Date.now() - db.build.lastSyncAt > SYNC_INTERVAL_MS;
    if (due) {
      if (ids().voiceId) {
        const { status } = await vendors.elevenlabs.getVoiceStatus(ids().voiceId!).catch(() => ({ status: db.vendor.voiceStatus ?? "created" }));
        // ElevenLabs reports "created" for an unverified voice; keep our own needs_verification marker until training starts.
        const keep = status === "created" && (db.vendor.voiceStatus === "needs_verification" || db.vendor.voiceStatus === "samples_uploaded");
        if (!keep) store.update(() => (db.vendor.voiceStatus = status));
      }
      if (ids().replicaId) {
        const { status } = await vendors.tavus.getReplica(ids().replicaId!).catch(() => ({ status: db.vendor.replicaStatus ?? "started" }));
        store.update(() => (db.vendor.replicaStatus = status));
      }
      store.update(() => (db.build.lastSyncAt = Date.now()));
    }

    if (!ids().personaId && !db.build.errors.persona && db.vendor.voiceStatus === "ready" && ["completed", "ready"].includes(db.vendor.replicaStatus ?? "")) {
      try {
        await setupPersona(deps);
      } catch (err) {
        fail("persona", err);
      }
    }
  });
  return buildStatus(config, store);
}

/** The owner says they finished ElevenLabs verification: start voice training now. */
export async function confirmVoiceVerification(deps: SetupDeps): Promise<BuildStatus> {
  const { store, config } = deps;
  store.update((db) => {
    db.build.voiceVerificationConfirmedAt = new Date().toISOString();
  });
  try {
    await trainVoice(deps);
  } catch (err) {
    store.update((db) => {
      db.vendor.voiceStatus = "needs_verification";
    });
    throw new BuildPreconditionError("ElevenLabs does not show this voice as verified yet. Finish verification there (it can take a few minutes), then try again.");
  }
  return advanceBuild(deps, { sync: true });
}

/** Lets the owner retry a failed stage after fixing the cause (for example re-recording the video). */
export function resetBuildErrors(store: Store, stage?: StageId): void {
  store.update((db) => {
    if (stage) delete db.build.errors[stage];
    else db.build.errors = {};
  });
}
