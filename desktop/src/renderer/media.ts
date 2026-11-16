import { meterLevel } from "../shared/audioAnalysis.js";

export interface AudioRecorder {
  sampleRate: number;
  /** Live input level, available as soon as the recorder exists so the owner can check the mic before recording. */
  onLevel(listener: (level: { peak: number; rms: number; clipping: boolean }) => void): void;
  start(): void;
  stop(): Float32Array;
  close(): void;
}

export interface VideoTake {
  data: Uint8Array;
  mimeType: string;
  durationSec: number;
}

export interface VideoRecorder {
  stream: MediaStream | null;
  start(): void;
  stop(): Promise<VideoTake>;
  close(): void;
}

export interface Recorders {
  createAudioRecorder(): Promise<AudioRecorder>;
  createVideoRecorder(): Promise<VideoRecorder>;
}

const describeMediaError = (err: unknown) => {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "The app was not allowed to use your microphone or camera. Allow access in Windows Settings, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone or camera was found. Plug one in and try again.";
  if (name === "NotReadableError") return "Another app is using your microphone or camera. Close it and try again.";
  return "Could not start the microphone or camera.";
};

async function getStream(constraints: MediaStreamConstraints): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    throw new Error(describeMediaError(err));
  }
}

async function createAudioRecorder(): Promise<AudioRecorder> {
  // Processing is off so the noise and level checks describe the room honestly.
  const stream = await getStream({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const silent = context.createGain();
  silent.gain.value = 0;
  let chunks: Float32Array[] = [];
  let recording = false;
  let listener: ((level: { peak: number; rms: number; clipping: boolean }) => void) | null = null;
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    if (recording) chunks.push(new Float32Array(input));
    listener?.(meterLevel(input));
  };
  source.connect(processor);
  processor.connect(silent);
  silent.connect(context.destination);
  return {
    sampleRate: context.sampleRate,
    onLevel: (cb) => void (listener = cb),
    start() {
      chunks = [];
      recording = true;
    },
    stop() {
      recording = false;
      let total = 0;
      for (const c of chunks) total += c.length;
      const out = new Float32Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
      }
      chunks = [];
      return out;
    },
    close() {
      listener = null;
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void context.close();
    },
  };
}

async function createVideoRecorder(): Promise<VideoRecorder> {
  const stream = await getStream({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: { echoCancellation: false, noiseSuppression: true, channelCount: 1 } });
  const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "video/webm";
  let recorder: MediaRecorder | null = null;
  let parts: Blob[] = [];
  let startedAt = 0;
  return {
    stream,
    start() {
      parts = [];
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 128_000 });
      recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
      recorder.start(1000);
      startedAt = Date.now();
    },
    stop() {
      const active = recorder;
      return new Promise((resolve, reject) => {
        if (!active) return reject(new Error("Not recording."));
        active.onstop = async () => {
          const blob = new Blob(parts, { type: mimeType });
          resolve({ data: new Uint8Array(await blob.arrayBuffer()), mimeType, durationSec: Math.round((Date.now() - startedAt) / 100) / 10 });
        };
        active.stop();
      });
    },
    close() {
      if (recorder && recorder.state !== "inactive") recorder.stop();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

export const browserRecorders: Recorders = { createAudioRecorder, createVideoRecorder };

/** Downsamples the current camera frame for the lighting check; null when a frame is not available. */
export function sampleFrame(video: HTMLVideoElement): { rgba: Uint8ClampedArray; width: number; height: number } | null {
  try {
    if (!video.videoWidth) return null;
    const width = 64;
    const height = 48;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);
    return { rgba: ctx.getImageData(0, 0, width, height).data, width, height };
  } catch {
    return null;
  }
}
