import { newId, type MemoryTurn, type Person, type PersonMemory, type Store } from "../store.js";
import type { LlmClient } from "../vendors/types.js";

const MAX_TURNS = 40;
const MAX_NOTES = 40;

const FIRST_PERSON = /\b(i|i'm|i've|my|we|we're|our)\b/i;

export function getMemory(store: Store, personId: string): PersonMemory {
  return store.data.memories[personId] ?? { personId, notes: [], turns: [] };
}

/** Pull short first-person statements people tell the clone so it can bring them up next time. */
export function extractPersonNotes(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && s.length <= 200 && FIRST_PERSON.test(s))
    .map((s) => s.replace(/[.!?]+$/, ""));
}

export function recordTurn(store: Store, personId: string, userText: string, assistantText: string, now = new Date()) {
  store.update((db) => {
    const mem = db.memories[personId] ?? { personId, notes: [], turns: [] };
    const at = now.toISOString();
    const lastUser = [...mem.turns].reverse().find((t) => t.role === "user");
    if (lastUser && lastUser.content === userText && now.getTime() - Date.parse(lastUser.at) < 5000) {
      // Tavus can retry the same utterance (speculative inference); keep one copy.
      const lastAssistantIdx = mem.turns.length - 1;
      if (mem.turns[lastAssistantIdx]?.role === "assistant") mem.turns[lastAssistantIdx]!.content = assistantText;
    } else {
      mem.turns.push({ role: "user", content: userText, at }, { role: "assistant", content: assistantText, at });
      for (const note of extractPersonNotes(userText)) {
        if (!mem.notes.some((n) => n.toLowerCase() === note.toLowerCase())) mem.notes.push(note);
      }
    }
    mem.turns = mem.turns.slice(-MAX_TURNS);
    mem.notes = mem.notes.slice(-MAX_NOTES);
    mem.lastConversationAt = at;
    db.memories[personId] = mem;
  });
}

export function clearMemory(store: Store, personId: string) {
  store.update((db) => {
    delete db.memories[personId];
  });
}

export function recentTurns(mem: PersonMemory, n = 6): MemoryTurn[] {
  return mem.turns.slice(-n);
}

/** After a call, let the LLM distil durable facts about the person (skipped in mock mode). */
export async function summarizeSession(store: Store, llm: LlmClient, person: Person, sinceIso: string) {
  if (llm.mock) return;
  const mem = getMemory(store, person.id);
  const turns = mem.turns.filter((t) => t.at >= sinceIso);
  if (turns.length < 2) return;
  const transcript = turns.map((t) => `${t.role === "user" ? person.name : "Clone"}: ${t.content}`).join("\n");
  const out = await llm.complete(
    [
      {
        role: "system",
        content:
          "Extract up to 5 short, durable facts worth remembering about the person the clone is talking to (life events, preferences, names, plans). Reply as a JSON object {\"notes\": string[]}. Use [] when nothing is worth remembering.",
      },
      { role: "user", content: transcript },
    ],
    { json: true, temperature: 0 },
  );
  try {
    const notes = (JSON.parse(out).notes ?? []) as unknown[];
    store.update((db) => {
      const m = db.memories[person.id];
      if (!m) return;
      for (const n of notes) {
        if (typeof n === "string" && n.trim() && !m.notes.includes(n.trim())) m.notes.push(n.trim());
      }
      m.notes = m.notes.slice(-MAX_NOTES);
    });
  } catch {
    /* summarisation is best effort */
  }
}

export { newId };
