import { createHmac, timingSafeEqual } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { Request } from "express";
import type { Config } from "./config.js";
import { newId, type MediaItem, type Store } from "./store.js";

export const mediaDirOf = (config: Config) => path.join(config.dataDir, "media");

const EXT_KIND: Record<string, MediaItem["kind"]> = {
  ".wav": "audio", ".mp3": "audio", ".m4a": "audio", ".flac": "audio", ".ogg": "audio", ".aac": "audio",
  ".mp4": "video", ".mov": "video", ".webm": "video", ".mkv": "video",
  ".jpg": "photo", ".jpeg": "photo", ".png": "photo", ".heic": "photo", ".webp": "photo",
  ".txt": "text", ".md": "text", ".json": "text",
};

export function inferKind(filename: string, mimeType: string): MediaItem["kind"] | null {
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("image/")) return "photo";
  if (mimeType.startsWith("text/")) return "text";
  return EXT_KIND[path.extname(filename).toLowerCase()] ?? null;
}

export class UploadTooLarge extends Error {}

export async function saveUpload(
  req: Request,
  config: Config,
  store: Store,
  input: {
    filename: string;
    kind?: MediaItem["kind"];
    purpose: MediaItem["purpose"];
    ownerSpeaker?: number;
    durationSec?: number;
    durationEstimated?: boolean;
    promptId?: string;
    promptKind?: MediaItem["promptKind"];
    quality?: Record<string, unknown>;
  },
): Promise<MediaItem> {
  const mimeType = (req.header("content-type") ?? "application/octet-stream").split(";")[0]!.trim();
  const safeName = path.basename(input.filename).replace(/[^\w.\- ]/g, "_").slice(0, 120) || "upload";
  const kind = input.kind ?? inferKind(safeName, mimeType);
  if (!kind) throw new Error("unsupported file type");
  const id = newId("med");
  const storedAs = `${id}${path.extname(safeName).toLowerCase()}`;
  const dir = mediaDirOf(config);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, storedAs);
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > config.maxUploadBytes) cb(new UploadTooLarge("file too large"));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, createWriteStream(target));
  } catch (err) {
    await rm(target, { force: true });
    throw err;
  }
  if (bytes === 0) {
    await rm(target, { force: true });
    throw new Error("empty upload");
  }
  const item: MediaItem = {
    id,
    kind,
    filename: safeName,
    storedAs,
    bytes,
    mimeType,
    purpose: input.purpose,
    ownerSpeaker: input.ownerSpeaker,
    durationSec: input.durationSec,
    durationEstimated: input.durationEstimated,
    promptId: input.promptId,
    promptKind: input.promptKind,
    quality: input.quality,
    createdAt: new Date().toISOString(),
  };
  // A re-take replaces the previous recording of the same prompt.
  const replaced = input.promptId
    ? store.data.media.filter((m) => m.promptId === input.promptId && m.purpose === input.purpose)
    : [];
  store.update((db) => {
    db.media = db.media.filter((m) => !replaced.includes(m));
    db.transcripts = db.transcripts.filter((t) => !replaced.some((m) => m.id === t.mediaId));
    db.media.push(item);
  });
  await Promise.all(replaced.map((m) => rm(path.join(dir, m.storedAs), { force: true })));
  return item;
}

export async function deleteMedia(config: Config, store: Store, id: string): Promise<boolean> {
  const item = store.data.media.find((m) => m.id === id);
  if (!item) return false;
  await rm(path.join(mediaDirOf(config), item.storedAs), { force: true });
  store.update((db) => {
    db.media = db.media.filter((m) => m.id !== id);
    db.transcripts = db.transcripts.filter((t) => t.mediaId !== id);
  });
  return true;
}

const sign = (config: Config, id: string, exp: number) =>
  createHmac("sha256", config.sessionSecret).update(`media:${id}:${exp}`).digest("base64url");

/** Time-limited public URL so a vendor (Tavus replica training) can fetch one file without any key. */
export function signedMediaUrl(config: Config, id: string, ttlSeconds = 3600, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  return `${config.publicBaseUrl}/media/${id}?exp=${exp}&sig=${sign(config, id, exp)}`;
}

export function verifyMediaSignature(config: Config, id: string, exp: string, sig: string, now = Date.now()): boolean {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum * 1000 < now) return false;
  const want = Buffer.from(sign(config, id, expNum));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}
