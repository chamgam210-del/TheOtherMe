/** Per-clip checks for voice recordings: level, noise floor, clipping, silence. Runs on raw mono samples. */

export interface AudioQuality {
  verdict: "ok" | "warn" | "fail";
  durationSec: number;
  peakDb: number;
  speechDb: number;
  noiseFloorDb: number;
  snrDb: number;
  clippingPercent: number;
  speechRatio: number;
  issues: string[];
  advice: string[];
}

export const MIN_CLIP_SECONDS = 20;

const db = (x: number) => (x <= 1e-9 ? -120 : 20 * Math.log10(x));
const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))] ?? -120;

export function windowLevels(samples: Float32Array, sampleRate: number, windowSec = 0.05): number[] {
  const size = Math.max(1, Math.floor(sampleRate * windowSec));
  const out: number[] = [];
  for (let i = 0; i + size <= samples.length; i += size) {
    let sum = 0;
    for (let j = i; j < i + size; j++) sum += samples[j]! * samples[j]!;
    out.push(db(Math.sqrt(sum / size)));
  }
  return out;
}

export function analyzeAudio(samples: Float32Array, sampleRate: number, opts: { minSeconds?: number } = {}): AudioQuality {
  const durationSec = samples.length / sampleRate;
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]!);
    if (a > peak) peak = a;
    if (a >= 0.985) clipped++;
  }
  const levels = windowLevels(samples, sampleRate).sort((a, b) => a - b);
  const speechDb = percentile(levels, 0.9);
  const noiseFloorDb = percentile(levels, 0.1);
  const snrDb = speechDb - noiseFloorDb;
  const speechRatio = levels.length ? levels.filter((l) => l > noiseFloorDb + 10 && l > -50).length / levels.length : 0;
  const clippingPercent = samples.length ? (clipped / samples.length) * 100 : 0;

  const issues: string[] = [];
  const advice: string[] = [];
  const state = { verdict: "ok" as AudioQuality["verdict"] };
  const fail = (issue: string, tip: string) => {
    state.verdict = "fail";
    issues.push(issue);
    advice.push(tip);
  };
  const warn = (issue: string, tip: string) => {
    if (state.verdict === "ok") state.verdict = "warn";
    issues.push(issue);
    advice.push(tip);
  };

  const min = opts.minSeconds ?? MIN_CLIP_SECONDS;
  if (durationSec < min) fail(`Too short (${Math.round(durationSec)}s)`, `Record at least ${min} seconds so the voice model gets enough to learn from.`);
  if (peak === 0 || speechDb < -45) fail("Almost silent", "Check that the right microphone is selected in Windows and that it is not muted.");
  else if (speechDb < -38) fail("Too quiet", "Move closer to the microphone or raise the input level in Windows sound settings.");
  else if (speechDb < -30) warn("A bit quiet", "Move a little closer to the microphone.");
  if (clippingPercent > 0.5) fail("Distorted (clipping)", "Lower the microphone input level or sit further back. Loud peaks are cut off.");
  else if (clippingPercent > 0.05) warn("Some clipping", "Speak slightly softer or lower the input level.");
  if (speechRatio < 0.3 && state.verdict !== "fail") fail("Mostly silence", "Keep talking: reading continuously or telling a story works best.");
  if (noiseFloorDb > -35 || snrDb < 12) fail("Too much background noise", "Find a quieter room, close windows, and turn off fans and notifications.");
  else if (noiseFloorDb > -50 || snrDb < 25) warn("Some background noise", "A quieter room or a closer microphone gives a cleaner clone.");

  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    verdict: state.verdict,
    durationSec: r(durationSec),
    peakDb: r(db(peak)),
    speechDb: r(speechDb),
    noiseFloorDb: r(noiseFloorDb),
    snrDb: r(snrDb),
    clippingPercent: Math.round(clippingPercent * 1000) / 1000,
    speechRatio: Math.round(speechRatio * 100) / 100,
    issues,
    advice,
  };
}

/** 16-bit mono PCM WAV from float samples. */
export function encodeWav(chunks: Float32Array[], sampleRate: number): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => [...text].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + total * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, total * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i]!));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

export function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Live meter value (0..1) for one audio buffer. */
export function meterLevel(buffer: Float32Array): { peak: number; rms: number; clipping: boolean } {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const a = Math.abs(buffer[i]!);
    if (a > peak) peak = a;
    sum += a * a;
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, buffer.length)), clipping: peak >= 0.985 };
}
