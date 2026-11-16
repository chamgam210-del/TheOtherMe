/** Onboarding wizard: step list, validation and a small state machine. Pure and shared so it can be unit tested. */

export const STEP_IDS = ["welcome", "keys", "server", "voice", "video", "consent", "uploads", "about", "avoid", "invite", "build", "test"] as const;
export type StepId = (typeof STEP_IDS)[number];

export const STEP_TITLES: Record<StepId, string> = {
  welcome: "Welcome",
  keys: "Accounts and keys",
  server: "Your server",
  voice: "Record your voice",
  video: "Record your face",
  consent: "Consent video",
  uploads: "More material",
  about: "About you",
  avoid: "Topics to avoid",
  invite: "Invite people",
  build: "Build your AI self",
  test: "Test call",
};

export const OPTIONAL_STEPS: StepId[] = ["uploads"];

export const VOICE_TARGET_SECONDS = 30 * 60;
export const VIDEO_MIN_SECONDS = 90;
export const CONSENT_MIN_SECONDS = 8;

export type VendorKey = "tavus" | "elevenlabs" | "deepgram" | "llm";
export const VENDOR_KEYS: VendorKey[] = ["tavus", "elevenlabs", "deepgram", "llm"];

export const REQUIRED_ANSWERS = ["hometown", "work", "personality"] as const;

export interface WizardFacts {
  consent: { accepted: boolean; name: string };
  /** Keys that passed a live test, whether held by the server or (before the server exists) in app memory. */
  keys: Record<VendorKey, boolean>;
  serverConnected: boolean;
  serverCheck: { reachable: boolean; https: boolean; persistentStorage: boolean; isCloneme: boolean } | null;
  voiceSeconds: number;
  replicaVideoSeconds: number | null;
  consentVideoSeconds: number | null;
  profile: { displayName: string; answers: Record<string, string> };
  avoidTopics: string[];
  avoidNone: boolean;
  people: number;
  inviteSkipped: boolean;
  buildReady: boolean;
  testCalls: number;
}

export interface Validation {
  ok: boolean;
  /** Why Next is disabled. */
  reasons: string[];
  /** Advice that does not block. */
  warnings: string[];
}

const pass = (warnings: string[] = []): Validation => ({ ok: true, reasons: [], warnings });
const block = (...reasons: string[]): Validation => ({ ok: false, reasons, warnings: [] });

export const emptyFacts = (): WizardFacts => ({
  consent: { accepted: false, name: "" },
  keys: { tavus: false, elevenlabs: false, deepgram: false, llm: false },
  serverConnected: false,
  serverCheck: null,
  voiceSeconds: 0,
  replicaVideoSeconds: null,
  consentVideoSeconds: null,
  profile: { displayName: "", answers: {} },
  avoidTopics: [],
  avoidNone: false,
  people: 0,
  inviteSkipped: false,
  buildReady: false,
  testCalls: 0,
});

const needsServer = "Connect your server first (step 3).";

export function validateStep(step: StepId, f: WizardFacts): Validation {
  switch (step) {
    case "welcome": {
      const reasons: string[] = [];
      if (!f.consent.accepted) reasons.push("Tick the box to confirm you understand.");
      if (f.consent.name.trim().length < 2) reasons.push("Type your full legal name.");
      return reasons.length ? block(...reasons) : pass();
    }
    case "keys": {
      const names: Record<VendorKey, string> = { tavus: "Tavus", elevenlabs: "ElevenLabs", deepgram: "Deepgram", llm: "your AI model provider" };
      const missing = VENDOR_KEYS.filter((k) => !f.keys[k]).map((k) => `Add and test the key for ${names[k]}.`);
      return missing.length ? block(...missing) : pass();
    }
    case "server": {
      if (!f.serverCheck) return block("Enter your server address and press Check.");
      if (!f.serverCheck.reachable) return block("The app cannot reach that address. Check it and try again.");
      if (!f.serverCheck.isCloneme) return block("That address answered, but it is not a cloneME server.");
      if (!f.serverCheck.https) return block("The server must use https:// so video calls and vendors can reach it.");
      if (!f.serverConnected) return block("Sign in to your server with the setup token (or your owner code).");
      return f.serverCheck.persistentStorage ? pass() : pass(["The server did not report persistent storage. If it restarts you could lose your data. Use the Render one-click deploy, which adds a disk."]);
    }
    case "voice": {
      if (!f.serverConnected) return block(needsServer);
      const mins = Math.floor(f.voiceSeconds / 60);
      return f.voiceSeconds >= VOICE_TARGET_SECONDS ? pass() : block(`Record at least 30 minutes in total (you have ${mins}).`);
    }
    case "video": {
      if (!f.serverConnected) return block(needsServer);
      if (f.replicaVideoSeconds === null) return block("Record your training video.");
      return f.replicaVideoSeconds >= VIDEO_MIN_SECONDS ? pass() : block("The training video should be about 2 minutes. Record it again.");
    }
    case "consent": {
      if (!f.serverConnected) return block(needsServer);
      if (f.consentVideoSeconds === null) return block("Record the consent video.");
      return f.consentVideoSeconds >= CONSENT_MIN_SECONDS ? pass() : block("That clip is too short to contain the full statement. Record it again.");
    }
    case "uploads":
      return f.serverConnected ? pass() : block(needsServer);
    case "about": {
      if (!f.serverConnected) return block(needsServer);
      const missing = REQUIRED_ANSWERS.filter((id) => (f.profile.answers[id] ?? "").trim().length < 2);
      return missing.length ? block(`Answer the required questions (${missing.length} left).`) : pass();
    }
    case "avoid":
      if (!f.serverConnected) return block(needsServer);
      return f.avoidTopics.length || f.avoidNone ? pass() : block("Add at least one topic, or tick that there is nothing to avoid.");
    case "invite":
      if (!f.serverConnected) return block(needsServer);
      return f.people > 0 || f.inviteSkipped ? pass() : block("Invite at least one person, or choose to invite people later.");
    case "build":
      if (!f.serverConnected) return block(needsServer);
      return f.buildReady ? pass() : block("Your AI self is not finished building yet.");
    case "test":
      if (!f.serverConnected) return block(needsServer);
      return f.testCalls > 0 ? pass() : block("Make a short test call to finish.");
  }
}

export interface WizardState {
  current: StepId;
  facts: WizardFacts;
  /** Owner mode: every step can be reopened, nothing is gated by order. */
  freeNavigation: boolean;
}

export type WizardAction =
  | { type: "next" }
  | { type: "back" }
  | { type: "goto"; step: StepId }
  | { type: "facts"; facts: WizardFacts };

export const stepIndex = (id: StepId) => STEP_IDS.indexOf(id);

/** First step (in order) whose validation fails; optional steps never block. */
export function firstIncomplete(facts: WizardFacts): StepId | null {
  return STEP_IDS.find((s) => !OPTIONAL_STEPS.includes(s) && !validateStep(s, facts).ok) ?? null;
}

/** Furthest step the user may open: everything up to and including the first incomplete step. */
export function furthestUnlocked(facts: WizardFacts): StepId {
  return firstIncomplete(facts) ?? STEP_IDS[STEP_IDS.length - 1]!;
}

export function canGoto(state: WizardState, target: StepId): boolean {
  if (state.freeNavigation) return true;
  return stepIndex(target) <= stepIndex(furthestUnlocked(state.facts));
}

/** Where to resume: the saved step if still reachable, otherwise the first unfinished one. */
export function resumeStep(saved: string | undefined, facts: WizardFacts, freeNavigation = false): StepId {
  const savedStep = STEP_IDS.find((s) => s === saved);
  if (savedStep && (freeNavigation || stepIndex(savedStep) <= stepIndex(furthestUnlocked(facts)))) return savedStep;
  return firstIncomplete(facts) ?? "test";
}

export function createWizard(saved: string | undefined, facts: WizardFacts, freeNavigation = false): WizardState {
  return { current: resumeStep(saved, facts, freeNavigation), facts, freeNavigation };
}

export function reduce(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "facts":
      return { ...state, facts: action.facts };
    case "back": {
      const i = stepIndex(state.current);
      return i > 0 ? { ...state, current: STEP_IDS[i - 1]! } : state;
    }
    case "next": {
      if (!validateStep(state.current, state.facts).ok) return state;
      const i = stepIndex(state.current);
      return i < STEP_IDS.length - 1 ? { ...state, current: STEP_IDS[i + 1]! } : state;
    }
    case "goto":
      return canGoto(state, action.step) ? { ...state, current: action.step } : state;
  }
}

export function progress(facts: WizardFacts): { done: number; total: number; percent: number } {
  const total = STEP_IDS.length;
  const done = STEP_IDS.filter((s) => (OPTIONAL_STEPS.includes(s) ? facts.serverConnected : validateStep(s, facts).ok)).length;
  return { done, total, percent: Math.round((done / total) * 100) };
}

export const isLastStep = (id: StepId) => id === STEP_IDS[STEP_IDS.length - 1];
