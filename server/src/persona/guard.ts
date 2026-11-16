export const DEFLECTION = "Hmm, I'd rather not get into that one. What else is going on with you?";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function topicMatcher(topics: string[]): (text: string) => boolean {
  const patterns = topics
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(t)}($|[^\\p{L}\\p{N}])`, "iu"));
  return (text) => patterns.some((p) => p.test(text));
}

/**
 * Re-emits LLM deltas one sentence at a time so an avoid-topic mention is caught
 * before it is spoken. On a hit it speaks a deflection and drops the rest.
 */
export async function* guardStream(deltas: AsyncIterable<string>, avoidTopics: string[]): AsyncGenerator<string> {
  const hits = topicMatcher(avoidTopics);
  let buffer = "";
  const flush = function* (sentence: string): Generator<string, boolean> {
    if (hits(sentence)) {
      yield DEFLECTION;
      return false;
    }
    yield sentence;
    return true;
  };
  for await (const delta of deltas) {
    buffer += delta;
    let match: RegExpExecArray | null;
    while ((match = /^(.*?[.!?]["')\]]?)(\s+)/s.exec(buffer))) {
      buffer = buffer.slice(match[0].length);
      const ok = yield* flush(match[1]! + match[2]!);
      if (!ok) return;
    }
  }
  if (buffer.trim()) yield* flush(buffer);
}
