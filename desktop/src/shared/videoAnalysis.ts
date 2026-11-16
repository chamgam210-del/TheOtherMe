/** Lighting and framing checks on a downsampled camera frame (RGBA pixels). */

export interface LightingReport {
  verdict: "ok" | "warn" | "fail";
  meanLuma: number;
  contrast: number;
  leftRightDiff: number;
  blownPercent: number;
  issues: string[];
  advice: string[];
}

export function analyzeFrame(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): LightingReport {
  const luma = new Float32Array(width * height);
  let sum = 0;
  let blown = 0;
  for (let i = 0; i < luma.length; i++) {
    const y = 0.2126 * rgba[i * 4]! + 0.7152 * rgba[i * 4 + 1]! + 0.0722 * rgba[i * 4 + 2]!;
    luma[i] = y;
    sum += y;
    if (y > 245) blown++;
  }
  const mean = sum / luma.length;
  let variance = 0;
  let left = 0;
  let right = 0;
  let nl = 0;
  let nr = 0;
  const cx = width / 2;
  // Only the central area matters for the face, so the edges of the room do not skew the left/right check.
  for (let y = Math.floor(height * 0.15); y < height * 0.85; y++) {
    for (let x = Math.floor(width * 0.2); x < width * 0.8; x++) {
      const v = luma[y * width + x]!;
      if (x < cx) {
        left += v;
        nl++;
      } else {
        right += v;
        nr++;
      }
    }
  }
  for (let i = 0; i < luma.length; i++) variance += (luma[i]! - mean) ** 2;
  const contrast = Math.sqrt(variance / luma.length);
  const diff = Math.abs(left / Math.max(1, nl) - right / Math.max(1, nr));
  const blownPercent = (blown / luma.length) * 100;

  const issues: string[] = [];
  const advice: string[] = [];
  const state = { verdict: "ok" as LightingReport["verdict"] };
  const set = (level: "warn" | "fail", issue: string, tip: string) => {
    if (level === "fail" || state.verdict === "ok") state.verdict = level;
    issues.push(issue);
    advice.push(tip);
  };
  if (mean < 55) set("fail", "Too dark", "Face a window or put a lamp behind the camera, pointing at you.");
  else if (mean < 85) set("warn", "A little dark", "Add more light in front of you.");
  else if (mean > 205) set("fail", "Too bright", "Move away from direct light or lower the room lighting.");
  if (blownPercent > 8) set("warn", "Bright areas are washed out", "Avoid a bright window behind you; face the light instead.");
  if (diff > 40) set("warn", "Light comes from one side", "Face the light so both sides of your face look similar.");
  if (contrast < 18) set("warn", "Flat, low-contrast picture", "Add some distance from the background or more light on your face.");

  const r = (n: number) => Math.round(n * 10) / 10;
  return { verdict: state.verdict, meanLuma: r(mean), contrast: r(contrast), leftRightDiff: r(diff), blownPercent: r(blownPercent), issues, advice };
}
