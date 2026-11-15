import type { StylePack } from "../store.js";

const FILLERS = [
  "you know", "i mean", "kind of", "sort of", "like", "basically", "actually", "honestly",
  "literally", "right", "well", "anyway", "so yeah", "um", "uh", "dude", "man", "totally",
];

const STOP = new Set(
  "a an the and or but if so to of in on at for with is are was were be been it its this that i you he she we they me my your our their do does did have has had not no yes".split(" "),
);

const EXPANDED = /\b(do not|does not|did not|is not|are not|was not|were not|cannot|can not|will not|would not|should not|could not|i am|you are|we are|they are|it is|that is|i will|i would|i have|i had|let us)\b/gi;
const CONTRACTED = /\b\w+'(t|s|re|ll|ve|d|m)\b/gi;
const EMOJI = /\p{Extended_Pictographic}/u;

export const splitSentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, " ").split(/\s+/).filter(Boolean);

function topNgrams(sentences: string[], n: number, min: number, limit: number): [string, number][] {
  const counts = new Map<string, number>();
  for (const s of sentences) {
    const w = words(s);
    for (let i = 0; i + n <= w.length; i++) {
      const gram = w.slice(i, i + n);
      if (gram.every((g) => STOP.has(g))) continue;
      const key = gram.join(" ");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= min)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function pickExamples(utterances: string[], count: number): string[] {
  const candidates = utterances.map((u) => u.trim()).filter((u) => {
    const n = u.split(/\s+/).length;
    return n >= 6 && n <= 30;
  });
  if (candidates.length <= count) return candidates;
  const step = candidates.length / count;
  return Array.from({ length: count }, (_, i) => candidates[Math.floor(i * step)]!);
}

/** Deterministic style statistics over everything the owner said or wrote. */
export function extractStyle(utterances: string[], now = new Date()): StylePack {
  const clean = utterances.map((u) => u.trim()).filter(Boolean);
  const sentences = clean.flatMap(splitSentences);
  const allWords = clean.flatMap(words);
  const sentenceCount = Math.max(sentences.length, 1);
  const joined = clean.join(" ").toLowerCase();

  const contracted = (clean.join(" ").match(CONTRACTED) ?? []).length;
  const expanded = (clean.join(" ").match(EXPANDED) ?? []).length;

  const fillers = FILLERS.map((phrase) => ({
    phrase,
    count: (joined.match(new RegExp(`(^|[^\\p{L}])${phrase}(?=$|[^\\p{L}])`, "gu")) ?? []).length,
  }))
    .filter((f) => f.count >= 2)
    .sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase))
    .slice(0, 5);

  const openerCounts = new Map<string, number>();
  for (const s of sentences) {
    const w = words(s).slice(0, 2).join(" ");
    if (w) openerCounts.set(w, (openerCounts.get(w) ?? 0) + 1);
  }
  const openers = [...openerCounts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([o]) => o);

  const grams = [...topNgrams(sentences, 4, 2, 8), ...topNgrams(sentences, 3, 2, 8), ...topNgrams(sentences, 2, 3, 8)];
  const signaturePhrases = grams
    .filter(([g, c], i) => !grams.some(([o, oc], j) => j !== i && o.length > g.length && o.includes(g) && oc >= c))
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 8)
    .map(([g]) => g);

  return {
    sampleCount: clean.length,
    wordCount: allWords.length,
    avgSentenceWords: round(allWords.length / sentenceCount),
    questionRate: round(sentences.filter((s) => s.endsWith("?")).length / sentenceCount),
    exclamationRate: round(sentences.filter((s) => s.endsWith("!")).length / sentenceCount),
    contractionRate: round(contracted + expanded === 0 ? 0 : contracted / (contracted + expanded)),
    emojiRate: round(clean.filter((u) => EMOJI.test(u)).length / Math.max(clean.length, 1)),
    lowercaseStartRate: round(sentences.filter((s) => /^\p{Ll}/u.test(s)).length / sentenceCount),
    fillers,
    openers,
    signaturePhrases,
    examples: pickExamples(clean, 8),
    updatedAt: now.toISOString(),
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
