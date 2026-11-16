import { readFileSync } from "node:fs";
import path from "node:path";
import { newId, type MediaItem, type Store, type TrainingJob, type Transcript } from "../store.js";
import type { Vendors } from "../vendors/types.js";
import { heuristicFacts, normalizeFact } from "./facts.js";
import { extractStyle } from "./style.js";

export interface PipelineDeps {
  store: Store;
  vendors: Vendors;
  mediaDir: string;
}

export interface PipelineOptions {
  /** Re-transcribe media that were already processed. */
  force?: boolean;
}

/** Utterances from the speaker who talks the most, unless the owner pinned a speaker id. */
export function pickOwnerSpeaker(utterances: Transcript["utterances"], pinned?: number): number {
  if (pinned !== undefined) return pinned;
  const counts = new Map<number, number>();
  for (const u of utterances) counts.set(u.speaker, (counts.get(u.speaker) ?? 0) + u.text.split(/\s+/).length);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
}

async function transcribeMedia(deps: PipelineDeps, media: MediaItem) {
  const { store, vendors, mediaDir } = deps;
  const result = await vendors.deepgram.transcribe({
    path: path.join(mediaDir, media.storedAs),
    filename: media.filename,
    mimeType: media.mimeType,
  });
  const transcript: Transcript = {
    id: newId("tr"),
    mediaId: media.id,
    text: result.text,
    utterances: result.utterances,
    ownerSpeaker: pickOwnerSpeaker(result.utterances, media.ownerSpeaker),
    createdAt: new Date().toISOString(),
  };
  store.update((db) => {
    db.transcripts = db.transcripts.filter((t) => t.mediaId !== media.id);
    db.transcripts.push(transcript);
    media.transcriptId = transcript.id;
    media.processedAt = new Date().toISOString();
    media.error = undefined;
  });
}

export function collectOwnerUtterances(deps: PipelineDeps): string[] {
  const { store, mediaDir } = deps;
  const out: string[] = [];
  for (const t of store.data.transcripts) {
    const media = store.data.media.find((m) => m.id === t.mediaId);
    const speaker = pickOwnerSpeaker(t.utterances, media?.ownerSpeaker);
    for (const u of t.utterances) if (u.speaker === speaker) out.push(u.text);
  }
  for (const m of store.data.media) {
    if (m.kind !== "text" || m.purpose !== "training") continue;
    try {
      const text = readFileSync(path.join(mediaDir, m.storedAs), "utf8");
      out.push(...text.split(/\r?\n\s*\r?\n|\r?\n/).map((l) => l.trim()).filter(Boolean));
    } catch {
      /* file removed */
    }
  }
  return out;
}

async function llmExtract(deps: PipelineDeps, utterances: string[], examples: string[]) {
  const { llm } = deps.vendors;
  if (llm.mock) return null;
  const sample = utterances.join("\n").slice(0, 14000);
  const raw = await llm.complete(
    [
      {
        role: "system",
        content:
          "You analyse transcripts of one person talking. Reply as JSON: {\"facts\": string[], \"voiceDescription\": string}. " +
          "facts: up to 25 durable first-person biographical facts or stable preferences explicitly stated (no guesses). " +
          "voiceDescription: 2-3 sentences describing how this person talks (tone, humour, pacing, vocabulary) in second person (\"You ...\").",
      },
      { role: "user", content: `Transcript lines:\n${sample}\n\nRepresentative lines:\n${examples.join("\n")}` },
    ],
    { json: true, temperature: 0.2 },
  );
  try {
    const json = JSON.parse(raw) as { facts?: unknown; voiceDescription?: unknown };
    return {
      facts: Array.isArray(json.facts) ? json.facts.filter((f): f is string => typeof f === "string") : [],
      voiceDescription: typeof json.voiceDescription === "string" ? json.voiceDescription : undefined,
    };
  } catch {
    return null;
  }
}

export async function runTraining(deps: PipelineDeps, options: PipelineOptions = {}): Promise<TrainingJob> {
  const { store } = deps;
  const job: TrainingJob = {
    id: newId("job"),
    status: "running",
    startedAt: new Date().toISOString(),
    processedMedia: 0,
    newFacts: 0,
  };
  store.update((db) => db.jobs.push(job));
  try {
    const pending = store.data.media.filter(
      (m) => (m.kind === "audio" || m.kind === "video") && (m.purpose === "training" || m.purpose === "voice") && m.promptKind !== "reading" && (options.force || !m.processedAt),
    );
    for (const media of pending) {
      try {
        await transcribeMedia(deps, media);
        job.processedMedia++;
      } catch (err) {
        store.update(() => {
          media.error = (err as Error).message;
        });
      }
    }
    store.update((db) => {
      for (const m of db.media) if (m.kind === "text" && m.purpose === "training" && !m.processedAt) {
        m.processedAt = new Date().toISOString();
        job.processedMedia++;
      }
    });

    const utterances = collectOwnerUtterances(deps);
    if (utterances.length) {
      const style = extractStyle(utterances);
      const llm = await llmExtract(deps, utterances, style.examples).catch(() => null);
      if (llm?.voiceDescription) style.voiceDescription = llm.voiceDescription;
      const candidates = llm?.facts.length ? llm.facts : heuristicFacts(utterances);
      store.update((db) => {
        db.style = style;
        const known = new Set(db.facts.map((f) => normalizeFact(f.text)));
        for (const text of candidates) {
          const key = normalizeFact(text);
          if (!key || known.has(key)) continue;
          known.add(key);
          db.facts.push({ id: newId("fact"), text, source: "training", status: "pending", createdAt: new Date().toISOString() });
          job.newFacts++;
        }
      });
    }
    store.update(() => {
      job.status = "done";
      job.finishedAt = new Date().toISOString();
    });
  } catch (err) {
    store.update(() => {
      job.status = "failed";
      job.error = (err as Error).message;
      job.finishedAt = new Date().toISOString();
    });
  }
  return job;
}

const running = new WeakMap<Store, Promise<TrainingJob>>();

/** Single-flight background run used by the owner API. */
export function startTraining(deps: PipelineDeps, options: PipelineOptions = {}): { started: boolean; done: Promise<TrainingJob> } {
  const current = running.get(deps.store);
  if (current) return { started: false, done: current };
  const done = runTraining(deps, options).finally(() => running.delete(deps.store));
  running.set(deps.store, done);
  return { started: true, done };
}
