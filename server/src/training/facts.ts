import { splitSentences } from "./style.js";

const FACT_PATTERNS: RegExp[] = [
  /^i('m| am) (a|an|the|from|originally|married|single|\d+)/i,
  /^i (grew up|was born|work|worked|live|lived|moved|studied|graduated|play|played|love|hate|like|enjoy|used to|have|got|met)/i,
  /^my (\w+ )?(wife|husband|partner|kid|kids|son|daughter|mom|mother|dad|father|brother|sister|dog|cat|job|favorite|favourite|hometown|name)\b/i,
  /^we (have|got|moved|live|lived|adopted)/i,
];

export const normalizeFact = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/** Fallback fact finder: first-person statements that look like biography or preferences. */
export function heuristicFacts(utterances: string[], limit = 30): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sentence of utterances.flatMap(splitSentences)) {
    const s = sentence.replace(/^(well|so|and|but|yeah|um|uh),?\s+/i, "").replace(/[.!]+$/, "").trim();
    if (s.length < 15 || s.length > 220 || s.endsWith("?")) continue;
    if (!FACT_PATTERNS.some((p) => p.test(s))) continue;
    const key = normalizeFact(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}
