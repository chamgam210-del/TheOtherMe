import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type Role = "owner" | "family" | "friend";

export interface Person {
  id: string;
  name: string;
  role: Role;
  relationship: string;
  codeHash: string;
  aiBanner: boolean;
  revoked: boolean;
  createdAt: string;
  lastSeenAt?: string;
}

export interface FamilyMember {
  name: string;
  relationship: string;
  notes?: string;
}

export interface Profile {
  displayName: string;
  basics: string;
  birthplace?: string;
  occupation?: string;
  family: FamilyMember[];
  avoidTopics: string[];
  updatedAt: string;
}

export interface StylePack {
  sampleCount: number;
  wordCount: number;
  avgSentenceWords: number;
  questionRate: number;
  exclamationRate: number;
  contractionRate: number;
  emojiRate: number;
  lowercaseStartRate: number;
  fillers: { phrase: string; count: number }[];
  openers: string[];
  signaturePhrases: string[];
  examples: string[];
  voiceDescription?: string;
  updatedAt: string;
}

export interface LearnedFact {
  id: string;
  text: string;
  source: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

export interface MediaItem {
  id: string;
  kind: "audio" | "video" | "photo" | "text";
  filename: string;
  storedAs: string;
  bytes: number;
  mimeType: string;
  purpose: "training" | "voice" | "replica" | "consent";
  ownerSpeaker?: number;
  transcriptId?: string;
  processedAt?: string;
  error?: string;
  createdAt: string;
}

export interface Transcript {
  id: string;
  mediaId: string;
  text: string;
  utterances: { speaker: number; start: number; end: number; text: string }[];
  ownerSpeaker: number;
  createdAt: string;
}

export interface MemoryTurn {
  role: "user" | "assistant";
  content: string;
  at: string;
}

export interface PersonMemory {
  personId: string;
  notes: string[];
  turns: MemoryTurn[];
  lastConversationAt?: string;
}

export interface SessionRecord {
  id: string;
  personId: string;
  conversationId: string;
  conversationUrl: string;
  mock: boolean;
  status: "active" | "ended";
  startedAt: string;
  endedAt?: string;
  tavusCreateMs: number;
}

export interface TrainingJob {
  id: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  processedMedia: number;
  newFacts: number;
  error?: string;
}

export interface VendorState {
  voiceId?: string;
  voiceStatus?: string;
  replicaId?: string;
  replicaStatus?: string;
  personaId?: string;
}

export interface DbShape {
  people: Person[];
  profile: Profile;
  style: StylePack | null;
  facts: LearnedFact[];
  media: MediaItem[];
  transcripts: Transcript[];
  memories: Record<string, PersonMemory>;
  sessions: SessionRecord[];
  jobs: TrainingJob[];
  vendor: VendorState;
}

export function emptyDb(ownerName: string): DbShape {
  return {
    people: [],
    profile: {
      displayName: ownerName,
      basics: "",
      family: [],
      avoidTopics: [],
      updatedAt: new Date().toISOString(),
    },
    style: null,
    facts: [],
    media: [],
    transcripts: [],
    memories: {},
    sessions: [],
    jobs: [],
    vendor: {},
  };
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

/** Small JSON-file store: fine for a pilot with a handful of people. Swap for a database later. */
export class Store {
  private db: DbShape;
  private readonly file: string | null;

  constructor(dataDir: string | null, ownerName: string) {
    this.file = dataDir ? path.join(dataDir, "db.json") : null;
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    if (this.file && existsSync(this.file)) {
      this.db = { ...emptyDb(ownerName), ...(JSON.parse(readFileSync(this.file, "utf8")) as Partial<DbShape>) };
    } else {
      this.db = emptyDb(ownerName);
    }
  }

  get data(): DbShape {
    return this.db;
  }

  save(): void {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    renameSync(tmp, this.file);
  }

  update<T>(fn: (db: DbShape) => T): T {
    const result = fn(this.db);
    this.save();
    return result;
  }
}
