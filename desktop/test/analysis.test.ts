import { describe, expect, it } from "vitest";
import { analyzeAudio, concat, encodeWav, meterLevel, windowLevels } from "../src/shared/audioAnalysis.js";
import { analyzeFrame } from "../src/shared/videoAnalysis.js";

const SR = 16000;

/** Speech-like test signal: a tone gated on and off (talking bursts) over a noise floor. */
function signal(opts: { seconds: number; speechAmp?: number; noiseAmp?: number; clip?: boolean }) {
  const n = Math.floor(opts.seconds * SR);
  const out = new Float32Array(n);
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const talking = Math.floor(i / (SR * 0.4)) % 3 !== 2;
    const tone = talking ? (opts.speechAmp ?? 0.25) * Math.sin((2 * Math.PI * 220 * i) / SR) : 0;
    let v = tone + (opts.noiseAmp ?? 0.0005) * rand();
    if (opts.clip) v *= 6;
    out[i] = Math.max(-1, Math.min(1, v));
  }
  return out;
}

describe("audio clip checks", () => {
  it("accepts a clean clip at a healthy level", () => {
    const q = analyzeAudio(signal({ seconds: 30 }), SR);
    expect(q.verdict).toBe("ok");
    expect(q.issues).toEqual([]);
    expect(q.durationSec).toBe(30);
    expect(q.snrDb).toBeGreaterThan(30);
    expect(q.speechRatio).toBeGreaterThan(0.5);
  });

  it("rejects clips that are too short", () => {
    const q = analyzeAudio(signal({ seconds: 5 }), SR);
    expect(q.verdict).toBe("fail");
    expect(q.issues[0]).toMatch(/Too short/);
    expect(analyzeAudio(signal({ seconds: 5 }), SR, { minSeconds: 3 }).verdict).toBe("ok");
  });

  it("flags quiet recordings, from a bit quiet to nearly silent", () => {
    expect(analyzeAudio(signal({ seconds: 30, speechAmp: 0.04 }), SR).verdict).toBe("warn");
    const quiet = analyzeAudio(signal({ seconds: 30, speechAmp: 0.008, noiseAmp: 0.00001 }), SR);
    expect(quiet.verdict).toBe("fail");
    expect(quiet.issues.join(" ")).toMatch(/quiet/i);
    expect(analyzeAudio(new Float32Array(SR * 30), SR).issues.join(" ")).toMatch(/silent/i);
  });

  it("detects clipping", () => {
    const q = analyzeAudio(signal({ seconds: 30, clip: true }), SR);
    expect(q.verdict).toBe("fail");
    expect(q.clippingPercent).toBeGreaterThan(0.5);
    expect(q.issues.join(" ")).toMatch(/clipping/);
    expect(q.advice.join(" ")).toMatch(/input level/);
  });

  it("detects background noise", () => {
    const noisy = analyzeAudio(signal({ seconds: 30, noiseAmp: 0.08 }), SR);
    expect(noisy.verdict).toBe("fail");
    expect(noisy.issues.join(" ")).toMatch(/noise/);
    const mild = analyzeAudio(signal({ seconds: 30, noiseAmp: 0.006 }), SR);
    expect(["warn", "ok"]).toContain(mild.verdict);
    expect(mild.noiseFloorDb).toBeGreaterThan(-60);
  });

  it("reports window levels and live meter values", () => {
    expect(windowLevels(new Float32Array(SR), SR)).toHaveLength(20);
    const m = meterLevel(Float32Array.from([0, 0.5, -0.99, 0.1]));
    expect(m.peak).toBeCloseTo(0.99);
    expect(m.clipping).toBe(true);
    expect(meterLevel(new Float32Array(0)).rms).toBe(0);
  });

  it("encodes a valid 16-bit mono WAV", () => {
    const wav = encodeWav([Float32Array.from([0, 1, -1]), Float32Array.from([0.5])], 22050);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(22050);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(8);
    expect(wav.byteLength).toBe(44 + 8);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
    expect(concat([Float32Array.from([1]), Float32Array.from([2, 3])])).toEqual(Float32Array.from([1, 2, 3]));
  });
});

function frame(w: number, h: number, pixel: (x: number, y: number) => number) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = pixel(x, y);
    const i = (y * w + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  return data;
}

describe("lighting check", () => {
  const W = 64;
  const H = 48;
  const natural = (x: number, y: number) => 120 + 50 * Math.sin(x / 5) * Math.cos(y / 4);

  it("passes evenly lit frames", () => {
    expect(analyzeFrame(frame(W, H, natural), W, H).verdict).toBe("ok");
  });

  it("flags dark and over-bright frames", () => {
    const dark = analyzeFrame(frame(W, H, () => 20), W, H);
    expect(dark.verdict).toBe("fail");
    expect(dark.issues).toContain("Too dark");
    expect(analyzeFrame(frame(W, H, () => 250), W, H).issues).toContain("Too bright");
  });

  it("warns about light from one side and flat pictures", () => {
    const side = analyzeFrame(frame(W, H, (x, y) => natural(x, y) * (x < W / 2 ? 1.5 : 0.6)), W, H);
    expect(side.issues).toContain("Light comes from one side");
    expect(analyzeFrame(frame(W, H, () => 120), W, H).issues).toContain("Flat, low-contrast picture");
  });
});
