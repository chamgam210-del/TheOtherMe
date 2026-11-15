/** Contract between the sandboxed renderer and the main process (which holds the session token and talks to the API). */

export interface Person {
  id: string;
  name: string;
  role: "owner" | "family" | "friend";
  relationship: string;
  aiBanner: boolean;
  ownerName: string;
}

export interface SessionInfo {
  sessionId: string;
  conversationUrl: string;
  mock: boolean;
  greeting: string;
  maxCallSeconds: number;
  banner: { text: string } | null;
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
}

export interface StylePack {
  sampleCount: number;
  wordCount: number;
  avgSentenceWords: number;
  questionRate: number;
  exclamationRate: number;
  contractionRate: number;
  fillers: { phrase: string; count: number }[];
  openers: string[];
  signaturePhrases: string[];
  examples: string[];
  voiceDescription?: string;
  updatedAt: string;
}

export interface Fact {
  id: string;
  text: string;
  status: "pending" | "approved" | "rejected";
}

export interface ManagedPerson {
  id: string;
  name: string;
  role: string;
  relationship: string;
  aiBanner: boolean;
  revoked: boolean;
  lastSeenAt: string | null;
  hasMemory: boolean;
}

export type MediaPurpose = "training" | "voice" | "replica" | "consent";

export interface MediaItem {
  id: string;
  kind: string;
  filename: string;
  bytes: number;
  purpose: MediaPurpose;
  processedAt?: string;
  error?: string;
}

export interface TrainingJob {
  id: string;
  status: "running" | "done" | "failed";
  processedMedia: number;
  newFacts: number;
  startedAt: string;
  error?: string;
}

export interface VendorStatus {
  mode: Record<"tavus" | "elevenlabs" | "deepgram" | "llm", "mock" | "live">;
  voice: { id: string | null; status: string };
  replica: { id: string | null; status: string };
  persona: { id: string | null };
  readyForCalls: boolean;
}

export interface UpdateStatus {
  state: "checking" | "available" | "downloading" | "ready" | "none" | "error";
  version?: string;
  percent?: number;
  message?: string;
}

export interface Bridge {
  getState(): Promise<{ apiBaseUrl: string; person: Person | null; version: string }>;
  signIn(code: string): Promise<Person>;
  signOut(): Promise<void>;
  startSession(): Promise<SessionInfo>;
  endSession(sessionId: string): Promise<void>;
  sendText(sessionId: string, text: string): Promise<{ reply: string }>;

  getProfile(): Promise<Profile>;
  saveProfile(profile: Partial<Profile>): Promise<Profile>;
  getStyle(): Promise<{ style: StylePack | null }>;
  getFacts(): Promise<{ facts: Fact[] }>;
  setFactStatus(id: string, status: Fact["status"]): Promise<Fact>;
  listPeople(): Promise<{ people: ManagedPerson[] }>;
  addPerson(input: { name: string; role: "family" | "friend"; relationship?: string }): Promise<{ person: ManagedPerson; inviteCode: string }>;
  revokePerson(id: string): Promise<void>;
  newInviteCode(id: string): Promise<{ inviteCode: string }>;
  setPersonBanner(id: string, aiBanner: boolean): Promise<ManagedPerson>;
  clearPersonMemory(id: string): Promise<void>;
  listMedia(): Promise<{ media: MediaItem[] }>;
  /** Opens a native file picker in the main process and uploads the chosen files. */
  pickAndUpload(purpose: MediaPurpose): Promise<{ uploaded: MediaItem[]; failed: { name: string; message: string }[] }>;
  deleteMedia(id: string): Promise<void>;
  runTraining(force?: boolean): Promise<{ started: boolean }>;
  listJobs(): Promise<{ jobs: TrainingJob[] }>;
  getVendors(sync?: boolean): Promise<VendorStatus>;
  setupVoice(): Promise<{ voiceId: string; note?: string }>;
  trainVoice(): Promise<{ voiceId: string }>;
  setupReplica(): Promise<{ replicaId: string; status: string }>;
  setupPersona(): Promise<{ personaId: string }>;
}

export type BridgeMethod = keyof Bridge;

export const BRIDGE_METHODS: BridgeMethod[] = [
  "getState", "signIn", "signOut", "startSession", "endSession", "sendText",
  "getProfile", "saveProfile", "getStyle", "getFacts", "setFactStatus", "listPeople", "addPerson",
  "revokePerson", "newInviteCode", "setPersonBanner", "clearPersonMemory", "listMedia", "pickAndUpload",
  "deleteMedia", "runTraining", "listJobs", "getVendors", "setupVoice", "trainVoice", "setupReplica", "setupPersona",
];

export interface BridgeExtras {
  onUpdate(listener: (status: UpdateStatus) => void): void;
  onSignedOut(listener: (reason: string) => void): void;
  installUpdate(): Promise<void>;
}

export type RendererBridge = Bridge & BridgeExtras;

export class BridgeError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}

declare global {
  interface Window {
    cloneme: RendererBridge;
  }
}
