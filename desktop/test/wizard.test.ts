import { describe, expect, it } from "vitest";
import { joinLink, normalizeServerUrl, parseInvite, shareMessage } from "../src/shared/invite.js";
import { AVOID_SUGGESTIONS, composeBasics, CONSENT_TEMPLATE, QUESTIONNAIRE, READINGS, STORIES, VOICE_PLAN_SECONDS, VOICE_PROMPTS } from "../src/shared/prompts.js";
import {
  canGoto, createWizard, emptyFacts, firstIncomplete, furthestUnlocked, progress, reduce, resumeStep, STEP_IDS, validateStep,
  type WizardFacts, type WizardState,
} from "../src/shared/wizard.js";

const complete = (): WizardFacts => ({
  consent: { accepted: true, name: "Sam Rivera" },
  keys: { tavus: true, elevenlabs: true, deepgram: true, llm: true },
  serverConnected: true,
  serverCheck: { reachable: true, https: true, persistentStorage: true, isCloneme: true },
  voiceSeconds: 31 * 60,
  replicaVideoSeconds: 120,
  consentVideoSeconds: 14,
  profile: { displayName: "Sam Rivera", answers: { hometown: "Portland", work: "Designer", personality: "warm, wry, curious" } },
  avoidTopics: ["politics"],
  avoidNone: false,
  people: 2,
  inviteSkipped: false,
  buildReady: true,
  testCalls: 1,
});

const withFacts = (patch: Partial<WizardFacts>): WizardFacts => ({ ...complete(), ...patch });

describe("step validation", () => {
  it("has twelve steps in the requested order", () => {
    expect(STEP_IDS).toEqual(["welcome", "keys", "server", "voice", "video", "consent", "uploads", "about", "avoid", "invite", "build", "test"]);
  });

  it("welcome needs the checkbox and a real name", () => {
    expect(validateStep("welcome", emptyFacts()).reasons).toHaveLength(2);
    expect(validateStep("welcome", withFacts({ consent: { accepted: true, name: "S" } })).ok).toBe(false);
    expect(validateStep("welcome", withFacts({ consent: { accepted: false, name: "Sam Rivera" } })).ok).toBe(false);
    expect(validateStep("welcome", complete()).ok).toBe(true);
  });

  it("keys lists every vendor that is still missing", () => {
    const v = validateStep("keys", withFacts({ keys: { tavus: true, elevenlabs: false, deepgram: false, llm: true } }));
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/ElevenLabs/);
    expect(v.reasons.join(" ")).toMatch(/Deepgram/);
    expect(v.reasons.join(" ")).not.toMatch(/Tavus/);
    expect(validateStep("keys", complete()).ok).toBe(true);
  });

  it("server needs reachable, cloneME, https and a signed-in connection; warns about missing disk", () => {
    expect(validateStep("server", withFacts({ serverCheck: null })).ok).toBe(false);
    expect(validateStep("server", withFacts({ serverCheck: { reachable: false, https: true, persistentStorage: true, isCloneme: false } })).reasons[0]).toMatch(/cannot reach/);
    expect(validateStep("server", withFacts({ serverCheck: { reachable: true, https: true, persistentStorage: true, isCloneme: false } })).reasons[0]).toMatch(/not a cloneME server/);
    expect(validateStep("server", withFacts({ serverCheck: { reachable: true, https: false, persistentStorage: true, isCloneme: true } })).reasons[0]).toMatch(/https/);
    expect(validateStep("server", withFacts({ serverConnected: false })).reasons[0]).toMatch(/Sign in/);
    const noDisk = validateStep("server", withFacts({ serverCheck: { reachable: true, https: true, persistentStorage: false, isCloneme: true } }));
    expect(noDisk.ok).toBe(true);
    expect(noDisk.warnings[0]).toMatch(/persistent storage/);
  });

  it("voice requires 30 minutes and reports progress", () => {
    const v = validateStep("voice", withFacts({ voiceSeconds: 29 * 60 + 59 }));
    expect(v.ok).toBe(false);
    expect(v.reasons[0]).toMatch(/at least 30 minutes.*you have 29/);
    expect(validateStep("voice", withFacts({ voiceSeconds: 30 * 60 })).ok).toBe(true);
  });

  it("video and consent need a recording of sensible length", () => {
    expect(validateStep("video", withFacts({ replicaVideoSeconds: null })).ok).toBe(false);
    expect(validateStep("video", withFacts({ replicaVideoSeconds: 60 })).reasons[0]).toMatch(/2 minutes/);
    expect(validateStep("video", withFacts({ replicaVideoSeconds: 90 })).ok).toBe(true);
    expect(validateStep("consent", withFacts({ consentVideoSeconds: null })).ok).toBe(false);
    expect(validateStep("consent", withFacts({ consentVideoSeconds: 3 })).ok).toBe(false);
    expect(validateStep("consent", withFacts({ consentVideoSeconds: 8 })).ok).toBe(true);
  });

  it("uploads are always allowed once connected", () => {
    expect(validateStep("uploads", withFacts({ serverConnected: true })).ok).toBe(true);
    expect(validateStep("uploads", withFacts({ serverConnected: false })).ok).toBe(false);
  });

  it("about needs the required answers, ignoring blanks", () => {
    expect(validateStep("about", withFacts({ profile: { displayName: "S", answers: { hometown: "x", work: " ", personality: "" } } })).reasons[0]).toMatch(/3 left|2 left/);
    expect(validateStep("about", complete()).ok).toBe(true);
  });

  it("avoid, invite, build and test each require an explicit outcome", () => {
    expect(validateStep("avoid", withFacts({ avoidTopics: [], avoidNone: false })).ok).toBe(false);
    expect(validateStep("avoid", withFacts({ avoidTopics: [], avoidNone: true })).ok).toBe(true);
    expect(validateStep("invite", withFacts({ people: 0, inviteSkipped: false })).ok).toBe(false);
    expect(validateStep("invite", withFacts({ people: 0, inviteSkipped: true })).ok).toBe(true);
    expect(validateStep("build", withFacts({ buildReady: false })).ok).toBe(false);
    expect(validateStep("test", withFacts({ testCalls: 0 })).ok).toBe(false);
    expect(validateStep("test", complete()).ok).toBe(true);
  });

  it("every step after the server step explains that the server is needed first", () => {
    for (const step of ["voice", "video", "consent", "uploads", "about", "avoid", "invite", "build", "test"] as const) {
      expect(validateStep(step, withFacts({ serverConnected: false })).reasons[0]).toMatch(/Connect your server/);
    }
  });
});

describe("wizard state machine", () => {
  it("starts at the welcome step on a fresh install and will not skip ahead", () => {
    let s = createWizard(undefined, emptyFacts());
    expect(s.current).toBe("welcome");
    s = reduce(s, { type: "next" });
    expect(s.current).toBe("welcome");
    s = reduce(s, { type: "goto", step: "voice" });
    expect(s.current).toBe("welcome");
  });

  it("advances only when the current step validates, and goes back freely", () => {
    let s = createWizard(undefined, emptyFacts());
    s = reduce(s, { type: "facts", facts: { ...emptyFacts(), consent: { accepted: true, name: "Sam Rivera" } } });
    s = reduce(s, { type: "next" });
    expect(s.current).toBe("keys");
    s = reduce(s, { type: "next" });
    expect(s.current).toBe("keys");
    s = reduce(s, { type: "back" });
    expect(s.current).toBe("welcome");
    s = reduce(s, { type: "back" });
    expect(s.current).toBe("welcome");
  });

  it("walks the whole wizard once everything is valid, and stops at the end", () => {
    let s: WizardState = { current: "welcome", facts: complete(), freeNavigation: false };
    for (let i = 0; i < STEP_IDS.length - 1; i++) s = reduce(s, { type: "next" });
    expect(s.current).toBe("test");
    expect(reduce(s, { type: "next" }).current).toBe("test");
  });

  it("locks later steps behind the first incomplete one", () => {
    const facts = withFacts({ voiceSeconds: 600 });
    expect(firstIncomplete(facts)).toBe("voice");
    expect(furthestUnlocked(facts)).toBe("voice");
    const s: WizardState = { current: "keys", facts, freeNavigation: false };
    expect(canGoto(s, "voice")).toBe(true);
    expect(canGoto(s, "video")).toBe(false);
    expect(reduce(s, { type: "goto", step: "video" }).current).toBe("keys");
    expect(reduce(s, { type: "goto", step: "welcome" }).current).toBe("welcome");
  });

  it("lets an owner reopen any step in free navigation mode", () => {
    const s = createWizard("about", complete(), true);
    expect(s.current).toBe("about");
    expect(reduce(s, { type: "goto", step: "keys" }).current).toBe("keys");
    expect(reduce(createWizard(undefined, emptyFacts(), true), { type: "goto", step: "test" }).current).toBe("test");
  });

  it("resumes at the saved step when reachable, otherwise at the first unfinished step", () => {
    const facts = withFacts({ voiceSeconds: 600 });
    expect(resumeStep("keys", facts)).toBe("keys");
    expect(resumeStep("voice", facts)).toBe("voice");
    expect(resumeStep("build", facts)).toBe("voice");
    expect(resumeStep("garbage", facts)).toBe("voice");
    expect(resumeStep(undefined, complete())).toBe("test");
  });

  it("recomputes from new facts (progress is derived, so it survives restarts)", () => {
    const facts = withFacts({ voiceSeconds: 600 });
    let s = createWizard("voice", facts);
    expect(validateStep(s.current, s.facts).ok).toBe(false);
    s = reduce(s, { type: "facts", facts: { ...facts, voiceSeconds: 31 * 60 } });
    expect(reduce(s, { type: "next" }).current).toBe("video");
  });

  it("reports progress as completed steps over twelve", () => {
    expect(progress(emptyFacts())).toMatchObject({ done: 0, total: 12, percent: 0 });
    expect(progress(complete())).toMatchObject({ done: 12, percent: 100 });
    const p = progress(withFacts({ buildReady: false, testCalls: 0 }));
    expect(p.done).toBe(10);
  });
});

describe("invite helpers", () => {
  it("normalizes server addresses", () => {
    expect(normalizeServerUrl("my-app.onrender.com/")).toBe("https://my-app.onrender.com");
    expect(normalizeServerUrl("http://localhost:8787/path")).toBe("http://localhost:8787");
    expect(normalizeServerUrl("")).toBeNull();
    expect(normalizeServerUrl("ftp://x.com")).toBeNull();
  });

  it("parses codes, links, and pasted combos", () => {
    expect(parseInvite("abcd-efgh-jklm")).toEqual({ code: "ABCD-EFGH-JKLM" });
    expect(parseInvite("ABCD EFGH JKLM")).toEqual({ code: "ABCD-EFGH-JKLM" });
    expect(parseInvite(joinLink("https://x.onrender.com", "ABCD-EFGH-JKLM"))).toEqual({ code: "ABCD-EFGH-JKLM", serverUrl: "https://x.onrender.com" });
    expect(parseInvite("https://x.onrender.com  ABCD-EFGH-JKLM")).toEqual({ code: "ABCD-EFGH-JKLM", serverUrl: "https://x.onrender.com" });
    expect(parseInvite("nope")).toBeNull();
    expect(parseInvite("")).toBeNull();
  });

  it("writes a share message with everything a friend needs", () => {
    const m = shareMessage({ friendName: "Alex Kim", ownerName: "Sam", installerUrl: "https://example.com/dl", serverUrl: "https://x.onrender.com", code: "ABCD-EFGH-JKLM" });
    expect(m).toContain("Hi Alex!");
    expect(m).toContain("https://example.com/dl");
    expect(m).toContain("cloneme://join?server=https%3A%2F%2Fx.onrender.com&code=ABCD-EFGH-JKLM");
    expect(m).toContain("AI");
  });
});

describe("prompts and questionnaire", () => {
  it("plans well over 30 minutes of voice material with unique ids", () => {
    expect(VOICE_PLAN_SECONDS).toBeGreaterThanOrEqual(35 * 60);
    expect(new Set(VOICE_PROMPTS.map((p) => p.id)).size).toBe(VOICE_PROMPTS.length);
    expect(READINGS.length).toBeGreaterThanOrEqual(8);
    expect(STORIES.length).toBeGreaterThanOrEqual(12);
    for (const p of READINGS) expect(p.text.split(/\s+/).length).toBeGreaterThan(80);
    for (const p of VOICE_PROMPTS) expect(p.id).toMatch(/^[\w-]{1,40}$/);
  });

  it("builds the exact consent statement from the owner's name", () => {
    expect(CONSENT_TEMPLATE("  Sam Rivera ")).toBe("I, Sam Rivera, am currently speaking and give consent to Tavus to create an AI clone of me by using the audio and video samples I'm providing. I understand that this AI clone can be used to create videos that look and sound like me.");
  });

  it("composes the about-me text from answers", () => {
    const text = composeBasics("Sam Rivera", { nickname: "Sammy", hometown: "Portland", work: "Designer", humor: " " });
    expect(text).toContain("My name is Sam Rivera (people call me Sammy).");
    expect(text).toContain("Where I grew up: Portland");
    expect(text).not.toContain("sense of humor");
    expect(QUESTIONNAIRE.filter((q) => q.required).map((q) => q.id)).toEqual(["hometown", "work", "personality"]);
    expect(AVOID_SUGGESTIONS.length).toBeGreaterThan(5);
  });
});
