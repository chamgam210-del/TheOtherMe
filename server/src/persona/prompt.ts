import type { LearnedFact, Person, PersonMemory, Profile, StylePack } from "../store.js";
import { recentTurns } from "./memory.js";

export const PERSON_MARKER = /\[\[cloneme:person=([A-Za-z0-9_]+)\]\]/;

export const personMarker = (personId: string) => `[[cloneme:person=${personId}]]`;

export interface PromptInput {
  profile: Profile;
  style: StylePack | null;
  facts: LearnedFact[];
  person: Person | null;
  memory: PersonMemory | null;
  raisedAvoidTopic?: boolean;
  now?: Date;
}

function describeStyle(s: StylePack): string[] {
  const lines: string[] = [];
  if (s.voiceDescription) lines.push(s.voiceDescription);
  lines.push(
    s.avgSentenceWords < 9
      ? "You speak in short, punchy sentences."
      : s.avgSentenceWords > 18
        ? "You tend to speak in longer, flowing sentences."
        : "You speak in medium-length sentences.",
  );
  if (s.contractionRate > 0.5) lines.push("You almost always use contractions (don't, I'm, it's).");
  if (s.exclamationRate > 0.15) lines.push("You are enthusiastic and use exclamations fairly often.");
  if (s.questionRate > 0.2) lines.push("You often ask questions back.");
  if (s.lowercaseStartRate > 0.5) lines.push("You are casual and informal.");
  if (s.fillers.length) lines.push(`Natural filler words you use: ${s.fillers.map((f) => `"${f.phrase}"`).join(", ")}. Use them sparingly.`);
  if (s.openers.length) lines.push(`Ways you often start a sentence: ${s.openers.map((o) => `"${o}"`).join(", ")}.`);
  if (s.signaturePhrases.length) lines.push(`Phrases that sound like you: ${s.signaturePhrases.map((o) => `"${o}"`).join(", ")}.`);
  if (s.examples.length) {
    lines.push("Real examples of how you talk (imitate the rhythm and word choice, do not repeat them verbatim):");
    for (const ex of s.examples) lines.push(`- ${ex}`);
  }
  return lines;
}

export function buildSystemPrompt(input: PromptInput): string {
  const { profile, style, facts, person, memory } = input;
  const name = profile.displayName;
  const out: string[] = [];
  out.push(
    `You are the AI version of ${name}, in a live spoken video call. Speak in first person as ${name}, in ${name}'s own voice and manner.`,
    "Your words are spoken aloud: keep replies to one to three short sentences unless asked for more. No markdown, lists, emojis or stage directions.",
    `You are an AI version of ${name}, not the real person. If anyone sincerely asks whether you are real, an AI or a recording, say plainly that you are an AI version of ${name}. Never claim to be human.`,
    `Only state facts you were given below. If you do not know something specific, say so naturally (for example "I'd have to check with the real me") instead of inventing details, dates, or memories.`,
  );

  if (person) {
    out.push(
      `\nYou are talking with ${person.name}${person.role === "owner" ? " (the real " + name + " testing you)" : `, ${name}'s ${person.relationship}`}. Address them by name occasionally, not every sentence.`,
    );
  } else {
    out.push("\nYou do not know who you are talking with. Be friendly and ask their name.");
  }

  out.push("\n## About you");
  if (profile.basics.trim()) out.push(profile.basics.trim());
  if (profile.birthplace) out.push(`You are from ${profile.birthplace}.`);
  if (profile.occupation) out.push(`Work: ${profile.occupation}.`);
  if (profile.family.length) {
    out.push("Your family and close people:");
    for (const f of profile.family) out.push(`- ${f.name} (${f.relationship})${f.notes ? `: ${f.notes}` : ""}`);
  }
  const approved = facts.filter((f) => f.status === "approved");
  if (approved.length) {
    out.push("Other things that are true about you:");
    for (const f of approved) out.push(`- ${f.text}`);
  }

  if (style) {
    out.push("\n## How you talk", ...describeStyle(style));
  }

  if (profile.avoidTopics.length) {
    out.push(
      "\n## Topics you never discuss",
      `Never bring up or discuss: ${profile.avoidTopics.join("; ")}. If someone raises one, kindly change the subject without explaining why.`,
    );
    if (input.raisedAvoidTopic) {
      out.push("The person just touched on one of those topics. Gently steer the conversation elsewhere in this reply.");
    }
  }

  if (memory && person) {
    out.push(`\n## What you remember about ${person.name}`);
    if (memory.notes.length) for (const n of memory.notes.slice(-15)) out.push(`- ${n}`);
    else out.push("- Nothing yet; this may be your first conversation.");
    if (memory.lastConversationAt) out.push(`You last spoke on ${memory.lastConversationAt.slice(0, 10)}.`);
    const turns = recentTurns(memory, 6);
    if (turns.length) {
      out.push("Tail of your previous conversation (for continuity only):");
      for (const t of turns) out.push(`${t.role === "user" ? person.name : name}: ${t.content}`);
    }
    out.push(`Never share what ${person.name} told you with anyone else.`);
  }
  return out.join("\n");
}

export function buildGreeting(profile: Profile, person: Person, memory: PersonMemory | null): string {
  const first = person.name.split(/\s+/)[0] ?? person.name;
  if (person.role === "owner") return `Hey ${first}, it's me. Or the AI me, anyway. Let's see how I'm doing.`;
  if (memory?.lastConversationAt) return `Hey ${first}! Good to see you again. How have you been?`;
  return `Hey ${first}! It's ${profile.displayName}. Well, the AI version of me. Great to see you.`;
}

export function buildConversationalContext(profile: Profile, person: Person): string {
  return [
    personMarker(person.id),
    `This is a live video call between the AI version of ${profile.displayName} and ${person.name} (${person.relationship}).`,
  ].join("\n");
}
