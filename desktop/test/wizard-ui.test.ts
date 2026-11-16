// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildStatus, KeyResult, MediaItem, OnboardingData, Person, RecordingUpload, RendererBridge, VendorName } from "../src/shared/bridge.js";
import { mountApp } from "../src/renderer/app.js";
import type { Recorders } from "../src/renderer/media.js";
import { STEP_IDS } from "../src/shared/wizard.js";

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = <T extends HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T;
const click = async (root: ParentNode, sel: string) => {
  const el = $<HTMLElement>(root, sel);
  expect(el, sel).toBeTruthy();
  el.click();
  await flush();
};
const type = async (root: ParentNode, sel: string, value: string) => {
  const el = $<HTMLInputElement>(root, sel);
  expect(el, sel).toBeTruthy();
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
};
const tick = async (root: ParentNode, sel: string) => {
  const el = $<HTMLInputElement>(root, sel);
  el.checked = true;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
};

const SR = 16000;
function speech(seconds: number, amp: number) {
  const out = new Float32Array(seconds * SR);
  for (let i = 0; i < out.length; i++) {
    const talking = Math.floor(i / (SR * 0.4)) % 3 !== 2;
    out[i] = (talking ? amp * Math.sin((2 * Math.PI * 220 * i) / SR) : 0) + 0.0003 * Math.sin(i * 12.9898);
  }
  return out;
}

const owner: Person = { id: "o1", name: "Sam Rivera", role: "owner", relationship: "self", aiBanner: false, ownerName: "Sam Rivera" };

/** In-memory stand-in for the app's main process, with the same rules as the real server. */
function fakeBridge() {
  const db = {
    connected: false,
    serverUrl: null as string | null,
    local: {} as Record<string, unknown>,
    stagedKeys: new Set<VendorName>(),
    savedKeys: new Set<VendorName>(),
    onboarding: { skipped: {} as Record<string, boolean>, avoidNone: false, consentAcceptedAt: undefined as string | undefined, consentName: undefined as string | undefined, currentStep: undefined as string | undefined, completedAt: undefined as string | undefined },
    media: [] as (MediaItem & { durationSec: number })[],
    profile: { displayName: "", answers: {} as Record<string, string>, family: [] as { name: string; relationship: string; notes?: string }[], avoidTopics: [] as string[] },
    people: [] as { id: string; name: string; role: "friend" | "family" | "owner"; relationship: string; revoked: boolean; aiBanner: boolean; hasMemory: boolean }[],
    build: { started: false, polls: 0, verified: false },
    testCalls: 0,
    uploads: [] as RecordingUpload[],
  };
  const ready = () => db.build.started && db.build.verified && db.build.polls > 3;
  const buildStatus = (): BuildStatus => {
    const waiting = db.build.started && db.build.polls >= 2 && !db.build.verified;
    const stage = (id: BuildStatus["stages"][number]["id"], label: string, status: BuildStatus["stages"][number]["status"], detail = "") => ({ id, label, status, detail });
    const s = !db.build.started ? "pending" : "done";
    return {
      started: db.build.started,
      ready: ready(),
      mock: true,
      stages: [
        stage("transcription", "Transcribe recordings", s, s === "done" ? "Done" : "Not started"),
        stage("voice", "Clone your voice", db.build.started ? (db.build.polls >= 1 ? "done" : "running") : "pending"),
        stage("voiceVerification", "Verify your voice with ElevenLabs", waiting ? "waiting" : db.build.verified ? "done" : "pending", waiting ? "ElevenLabs needs you to read a short text." : ""),
        stage("replica", "Create your face", db.build.verified ? "done" : "pending"),
        stage("persona", "Link your persona", ready() ? "done" : "pending"),
      ],
      manualAction: waiting ? { id: "elevenlabs-verification", title: "Verify your voice with ElevenLabs", steps: ["Open ElevenLabs Voices", "Press Verify voice", "Read the text aloud", "Come back and press the button"], link: "https://elevenlabs.io/app/voice-lab" } : null,
    };
  };
  const mediaFacts = () => {
    const voice = db.media.filter((m) => m.purpose === "voice");
    const last = (p: string) => [...db.media].reverse().find((m) => m.purpose === p);
    const v = last("replica");
    const c = last("consent");
    return {
      voiceSeconds: Math.round(voice.reduce((a, m) => a + m.durationSec, 0)),
      voiceClips: voice.map((m) => ({ id: m.id, promptId: m.promptId ?? null, durationSec: m.durationSec, estimated: false, filename: m.filename, quality: null })),
      replicaVideo: v ? { id: v.id, durationSec: v.durationSec, filename: v.filename } : null,
      consentVideo: c ? { id: c.id, durationSec: c.durationSec, filename: c.filename } : null,
    };
  };
  const vendors: VendorName[] = ["tavus", "elevenlabs", "deepgram", "llm"];

  const bridge = {
    getState: vi.fn(async () => ({ apiBaseUrl: db.serverUrl ?? "http://default", person: db.connected ? owner : null, version: "1", serverUrl: db.serverUrl })),
    signIn: vi.fn(),
    signOut: vi.fn(async () => {}),
    openExternal: vi.fn(async () => {}),
    checkServer: vi.fn(async (url: string) =>
      url.includes("down")
        ? { reachable: false, isCloneme: false, https: false, claimed: false, claimable: false, persistentStorage: false, publicBaseUrl: null, message: "Could not reach that address." }
        : { reachable: true, isCloneme: true, https: url.startsWith("https://"), claimed: db.connected, claimable: !db.connected, persistentStorage: true, publicBaseUrl: url, message: "Your server is online." },
    ),
    connectServer: vi.fn(async (input: { serverUrl: string; setupToken?: string; ownerCode?: string; ownerName?: string }) => {
      if (input.setupToken !== "right-token-123") throw new Error("That setup token is not right. Copy SETUP_TOKEN again from your server's environment settings.");
      db.connected = true;
      db.serverUrl = input.serverUrl;
      db.profile.displayName = input.ownerName ?? "Owner";
      db.people.push({ id: "o1", name: "Sam Rivera", role: "owner", relationship: "self", revoked: false, aiBanner: false, hasMemory: false });
      if (db.local.consentAccepted) {
        db.onboarding.consentAcceptedAt = "now";
        db.onboarding.consentName = String(db.local.consentName);
      }
      const keyResults: Record<string, KeyResult> = {};
      for (const k of db.stagedKeys) {
        db.savedKeys.add(k);
        keyResults[k] = { ok: true, message: "ok" };
      }
      db.stagedKeys.clear();
      return { person: owner, ownerCode: "ABCD-EFGH-JKLM", keyResults };
    }),
    getLocalWizard: vi.fn(async () => db.local),
    saveLocalWizard: vi.fn(async (patch: Record<string, unknown>) => Object.assign(db.local, patch)),
    submitKeys: vi.fn(async (keys: Record<string, unknown>) => {
      const results: Record<string, KeyResult> = {};
      for (const v of vendors) {
        const raw = v === "llm" ? (keys.llm as { apiKey?: string } | undefined)?.apiKey : (keys[v] as string | undefined);
        if (!raw) continue;
        if (raw.startsWith("bad")) results[v] = { ok: false, message: `${v} rejected this key. Copy it again (no spaces).` };
        else {
          results[v] = { ok: true, message: `${v} key works.`, ...(v === "elevenlabs" ? { warning: "This plan does not include Professional Voice Cloning." } : {}) };
          (db.connected ? db.savedKeys : db.stagedKeys).add(v);
        }
      }
      return { results, stagedOnly: !db.connected };
    }),
    getKeysStatus: vi.fn(async () => ({
      connected: db.connected,
      mockMode: false,
      llm: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
      vendors: Object.fromEntries(vendors.map((v) => [v, { saved: db.savedKeys.has(v), staged: db.stagedKeys.has(v), source: db.savedKeys.has(v) ? "app" : null, check: db.savedKeys.has(v) ? { ok: true, message: "ok", checkedAt: "now" } : null, warning: v === "elevenlabs" && (db.savedKeys.has(v) || db.stagedKeys.has(v)) ? "This plan does not include Professional Voice Cloning." : null }])),
    })),
    recheckKeys: vi.fn(async () => ({ results: {} })),
    getOnboarding: vi.fn(async (): Promise<OnboardingData | null> =>
      db.connected
        ? {
            state: { ...db.onboarding },
            facts: {
              ...mediaFacts(),
              optionalUploads: 0,
              profile: { ...db.profile },
              people: db.people.filter((p) => p.role !== "owner" && !p.revoked).length,
              testCalls: db.testCalls,
              ready: ready(),
            },
            installerUrl: "https://example.com/cloneME-Setup.exe",
            serverUrl: db.serverUrl ?? "",
          }
        : null,
    ),
    saveOnboarding: vi.fn(async (patch: Record<string, unknown>) => {
      if (patch.consentAccepted) {
        db.onboarding.consentAcceptedAt = "now";
        db.onboarding.consentName = String(patch.consentName ?? db.onboarding.consentName);
      }
      if (patch.currentStep) db.onboarding.currentStep = String(patch.currentStep);
      if (patch.skipped) Object.assign(db.onboarding.skipped, patch.skipped);
      if (patch.avoidNone !== undefined) db.onboarding.avoidNone = Boolean(patch.avoidNone);
      if (patch.completed) db.onboarding.completedAt = "done";
    }),
    uploadRecording: vi.fn(async (rec: RecordingUpload) => {
      db.uploads.push(rec);
      db.media = db.media.filter((m) => !(m.promptId && m.promptId === rec.promptId && m.purpose === rec.purpose));
      const item = { id: `m${db.media.length + 1}`, filename: rec.filename, kind: rec.mimeType.startsWith("video") ? "video" : "audio", purpose: rec.purpose, bytes: rec.data.length, createdAt: "now", durationSec: rec.durationSec, promptId: rec.promptId } as MediaItem & { durationSec: number };
      db.media.push(item);
      return item;
    }),
    uploadExistingVoice: vi.fn(async () => ({ uploaded: [], failed: [] })),
    pickAndUpload: vi.fn(async () => ({ uploaded: [], failed: [] })),
    listMedia: vi.fn(async () => ({ media: db.media })),
    deleteMedia: vi.fn(async () => {}),
    getBuild: vi.fn(async () => {
      if (db.build.started) db.build.polls++;
      return buildStatus();
    }),
    startBuild: vi.fn(async () => {
      db.build.started = true;
      return buildStatus();
    }),
    confirmVoiceVerified: vi.fn(async () => {
      db.build.verified = true;
      db.build.polls = 4;
      return buildStatus();
    }),
    retryBuildStage: vi.fn(async () => buildStatus()),
    saveProfile: vi.fn(async (p: Partial<typeof db.profile> & { answers?: Record<string, string> }) => {
      Object.assign(db.profile, p);
      return db.profile;
    }),
    listPeople: vi.fn(async () => ({ people: db.people })),
    addPerson: vi.fn(async (input: { name: string; role: "friend" | "family"; relationship?: string }) => {
      const p = { id: `p${db.people.length}`, name: input.name, role: input.role, relationship: input.relationship ?? input.role, revoked: false, aiBanner: true, hasMemory: false };
      db.people.push(p);
      return { person: p, inviteCode: "WXYZ-2345-ABCD" };
    }),
    newInviteCode: vi.fn(async () => ({ inviteCode: "NEWC-ODE2-3456" })),
    startSession: vi.fn(async () => ({ sessionId: "s1", conversationUrl: "mock://x", mock: true, greeting: "Hey", maxCallSeconds: 600, banner: null })),
    endSession: vi.fn(async () => {
      db.testCalls++;
    }),
    sendText: vi.fn(),
    onUpdate: vi.fn(),
    onSignedOut: vi.fn(),
    installUpdate: vi.fn(),
  };
  return { bridge, db };
}

function fakeRecorders(clip: { seconds: number; amp: number }) {
  const state = { clip, audioCreated: 0, videoCreated: 0, videoClosed: 0, audioClosed: 0, denyCamera: false };
  const recorders: Recorders = {
    async createAudioRecorder() {
      state.audioCreated++;
      return {
        sampleRate: SR,
        onLevel: () => {},
        start: () => {},
        stop: () => speech(state.clip.seconds, state.clip.amp),
        close: () => void state.audioClosed++,
      };
    },
    async createVideoRecorder() {
      if (state.denyCamera) throw new Error("The app was not allowed to use your microphone or camera. Allow access in Windows Settings, then try again.");
      state.videoCreated++;
      return {
        stream: null,
        start: () => {},
        stop: async () => ({ data: new Uint8Array(2048), mimeType: "video/webm", durationSec: state.clip.seconds }),
        close: () => void state.videoClosed++,
      };
    },
  };
  return { recorders, state };
}

function mount(opts: { person?: Person | null; clip?: { seconds: number; amp: number } } = {}) {
  const { bridge, db } = fakeBridge();
  const rec = fakeRecorders(opts.clip ?? { seconds: 130, amp: 0.25 });
  const calls: string[] = [];
  const createCall = vi.fn(async (req: { onState(s: string): void }) => {
    calls.push("call");
    req.onState("live");
    return { setMuted() {}, setCameraOff() {}, async leave() {} };
  });
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  mountApp(root, { bridge: bridge as unknown as RendererBridge, createCall: createCall as never, recorders: rec.recorders, pollMs: 5 });
  return { root, bridge, db, rec, createCall };
}

const stepOf = (root: ParentNode) => $(root, ".step-link.current").dataset.step;
const next = () => $<HTMLButtonElement>(document, "#wizard-next");

async function toKeys(m: ReturnType<typeof mount>) {
  await flush();
  await click(m.root, "#start-setup");
  await type(m.root, "#consent-name", "Sam Rivera");
  await tick(m.root, "#consent-check");
  await click(m.root, "#wizard-next");
}
async function addAllKeys(m: ReturnType<typeof mount>) {
  for (const v of ["tavus", "elevenlabs", "deepgram", "llm"]) {
    await type(m.root, `#key-${v}`, `good-${v}-key-123`);
    await click(m.root, `#test-${v}`);
  }
}
async function connect(m: ReturnType<typeof mount>) {
  await type(m.root, "#server-url", "https://my-ai.onrender.com");
  await click(m.root, "#check-server");
  await type(m.root, "#setup-token", "right-token-123");
  await click(m.root, "#connect-server");
}

describe("onboarding wizard UI", () => {
  beforeEach(() => vi.useRealTimers());

  it("starts from the sign-in screen, explains consent, and gates Next on the checkbox and name", async () => {
    const m = mount();
    await flush();
    await click(m.root, "#start-setup");
    expect(stepOf(m.root)).toBe("welcome");
    expect(m.root.textContent).toContain("What happens with your data");
    expect(next().disabled).toBe(true);
    expect($(m.root, "#wizard-reasons").textContent).toContain("Tick the box");
    await tick(m.root, "#consent-check");
    expect(next().disabled).toBe(true);
    await type(m.root, "#consent-name", "Sam Rivera");
    await flush();
    expect(next().disabled).toBe(false);
    expect($(m.root, ".stepper").querySelectorAll("li")).toHaveLength(12);
    await click(m.root, "#wizard-next");
    expect(stepOf(m.root)).toBe("keys");
    expect(m.bridge.saveLocalWizard).toHaveBeenCalledWith(expect.objectContaining({ consentAccepted: true, consentName: "Sam Rivera" }));
  });

  it("guides through each vendor account, tests keys live, and never keeps a key in the page", async () => {
    const m = mount();
    await toKeys(m);
    expect(stepOf(m.root)).toBe("keys");
    expect(m.root.querySelectorAll(".key-card")).toHaveLength(4);
    await click(m.root, '[data-open="tavus-signup"]');
    expect(m.bridge.openExternal).toHaveBeenCalledWith("https://platform.tavus.io");
    expect(m.root.textContent).toContain("held only in this app's memory");

    await type(m.root, "#key-tavus", "bad-key-123456");
    await click(m.root, "#test-tavus");
    expect($(m.root, "#result-tavus").textContent).toContain("rejected this key");
    expect(next().disabled).toBe(true);

    await addAllKeys(m);
    expect($<HTMLInputElement>(m.root, "#key-tavus").value).toBe("");
    expect($(m.root, "#result-elevenlabs").textContent).toContain("key works");
    expect($(m.root, '[data-vendor="elevenlabs"]').textContent).toContain("Professional Voice Cloning");
    expect(m.root.textContent).not.toContain("good-tavus-key-123");
    expect(next().disabled).toBe(false);
  });

  it("checks the server, claims it with the setup token, shows the owner code once, and moves staged keys over", async () => {
    const m = mount();
    await toKeys(m);
    await addAllKeys(m);
    await click(m.root, "#wizard-next");
    expect(stepOf(m.root)).toBe("server");
    expect(m.root.textContent).toContain("Render");
    await click(m.root, "#deploy-render");
    expect(m.bridge.openExternal).toHaveBeenCalledWith(expect.stringContaining("render.com/deploy"));

    await type(m.root, "#server-url", "my-ai-down.onrender.com");
    await click(m.root, "#check-server");
    expect($(m.root, "#server-checks").textContent).toMatch(/Could not reach|does not look right/);

    await type(m.root, "#server-url", "https://my-ai.onrender.com");
    await click(m.root, "#check-server");
    expect($(m.root, "#server-checks").textContent).toContain("Your server is online");
    expect(next().disabled).toBe(true);

    await type(m.root, "#setup-token", "wrong-token-00");
    await click(m.root, "#connect-server");
    expect($(m.root, "#connect-result").textContent).toContain("setup token is not right");

    await type(m.root, "#setup-token", "right-token-123");
    await click(m.root, "#connect-server");
    expect($(m.root, "#connect-result").textContent).toContain("Connected as Sam Rivera");
    expect($(m.root, "#connect-result").textContent).toContain("4 tested keys moved");
    expect($<HTMLInputElement>(m.root, "#owner-code-out").value).toBe("ABCD-EFGH-JKLM");
    expect($<HTMLInputElement>(m.root, "#setup-token").value).toBe("");
    expect(next().disabled).toBe(false);
    await click(m.root, "#wizard-next");
    expect(stepOf(m.root)).toBe("voice");
  });

  it("records voice clips with live quality checks, blocks bad takes, and counts toward 30 minutes", { timeout: 30000 }, async () => {
    const m = mount({ clip: { seconds: 130, amp: 0.25 } });
    await toKeys(m);
    await addAllKeys(m);
    await click(m.root, "#wizard-next");
    await connect(m);
    await click(m.root, "#wizard-next");
    expect(stepOf(m.root)).toBe("voice");
    expect(next().disabled).toBe(true);
    expect($(m.root, "#voice-progress").textContent).toContain("0:00 of 30:00");

    m.rec.state.clip = { seconds: 130, amp: 0.004 };
    await click(m.root, "#voice-record");
    await click(m.root, "#voice-stop");
    expect($(m.root, ".callout.error").textContent).toMatch(/quiet|silent/i);
    expect($<HTMLButtonElement>(m.root, "#voice-keep").disabled).toBe(true);
    await click(m.root, "#voice-redo");

    m.rec.state.clip = { seconds: 130, amp: 0.25 };
    let clips = 0;
    while (next().disabled && clips < 20) {
      await click(m.root, "#voice-record");
      await click(m.root, "#voice-stop");
      expect($(m.root, ".callout.ok")).toBeTruthy();
      await click(m.root, "#voice-keep");
      clips++;
    }
    expect(clips).toBe(14);
    expect(m.db.uploads.every((u) => u.purpose === "voice" && u.filename.endsWith(".wav") && u.promptId)).toBe(true);
    expect($(m.root, "#voice-progress").textContent).toContain("30:20 of 30:00");
    expect(m.root.querySelectorAll(".prompt-item.done").length).toBe(14);
    expect(m.rec.state.audioCreated).toBe(1);

    await click(m.root, "#wizard-next");
    expect(stepOf(m.root)).toBe("video");
    expect(m.rec.state.audioClosed).toBe(1);
  });

  it("walks the whole wizard end to end and finishes", { timeout: 30000 }, async () => {
    const m = mount();
    await toKeys(m);
    await addAllKeys(m);
    await click(m.root, "#wizard-next");
    await connect(m);
    await click(m.root, "#wizard-next");

    for (let i = 0; i < 14; i++) {
      await click(m.root, "#voice-record");
      await click(m.root, "#voice-stop");
      await click(m.root, "#voice-keep");
    }
    await click(m.root, "#wizard-next");

    expect(stepOf(m.root)).toBe("video");
    expect(m.root.textContent).toContain("Face inside the oval");
    expect($(m.root, "#replica-script").textContent).toContain("recording this video");
    await click(m.root, "#video-record");
    await click(m.root, "#video-stop");
    expect($(m.root, "#video-playback") ?? $(m.root, "#video-use")).toBeTruthy();
    await click(m.root, "#video-retake");
    await click(m.root, "#video-record");
    await click(m.root, "#video-stop");
    await click(m.root, "#video-use");
    expect(m.db.uploads.at(-1)).toMatchObject({ purpose: "replica", mimeType: "video/webm" });
    expect(next().disabled).toBe(false);
    await click(m.root, "#wizard-next");

    expect(stepOf(m.root)).toBe("consent");
    expect($(m.root, "#consent-script .script-text").textContent).toBe("I, Sam Rivera, am currently speaking and give consent to Tavus to create an AI clone of me by using the audio and video samples I'm providing. I understand that this AI clone can be used to create videos that look and sound like me.");
    m.rec.state.clip = { seconds: 3, amp: 0.25 };
    await click(m.root, "#video-record");
    await click(m.root, "#video-stop");
    expect($<HTMLButtonElement>(m.root, "#video-use").disabled).toBe(true);
    expect(m.root.textContent).toContain("too short");
    await click(m.root, "#video-retake");
    m.rec.state.clip = { seconds: 16, amp: 0.25 };
    await click(m.root, "#video-record");
    await click(m.root, "#video-stop");
    await click(m.root, "#video-use");
    await click(m.root, "#wizard-next");

    expect(stepOf(m.root)).toBe("uploads");
    expect(next().disabled).toBe(false);
    await click(m.root, "#upload-other");
    expect(m.bridge.pickAndUpload).toHaveBeenCalledWith("training");
    await click(m.root, "#wizard-next");

    expect(stepOf(m.root)).toBe("about");
    expect(next().disabled).toBe(true);
    await type(m.root, "#q-hometown", "Portland");
    await type(m.root, "#q-work", "Product designer");
    await type(m.root, "#q-personality", "warm, wry, a little scatterbrained");
    await new Promise((r) => setTimeout(r, 800));
    await flush();
    expect(m.db.profile.answers.hometown).toBe("Portland");
    expect(next().disabled).toBe(false);
    await type(m.root, "#fam-name", "Dana");
    await type(m.root, "#fam-rel", "sister");
    await click(m.root, "#fam-add");
    expect(m.db.profile.family).toEqual([{ name: "Dana", relationship: "sister", notes: undefined }]);
    await click(m.root, "#wizard-next");

    expect(stepOf(m.root)).toBe("avoid");
    expect(next().disabled).toBe(true);
    await click(m.root, '[data-topic="politics"]');
    expect(m.db.profile.avoidTopics).toEqual(["politics"]);
    await type(m.root, "#avoid-custom", "my ex");
    await click(m.root, "#avoid-add");
    expect(m.db.profile.avoidTopics).toEqual(["politics", "my ex"]);
    await click(m.root, "#wizard-next");

    expect(stepOf(m.root)).toBe("invite");
    expect(next().disabled).toBe(true);
    await type(m.root, "#invite-name", "Alex Kim");
    await type(m.root, "#invite-rel", "college friend");
    await click(m.root, "#invite-create");
    expect($(m.root, "#invite-code").textContent).toBe("WXYZ-2345-ABCD");
    const message = $<HTMLTextAreaElement>(m.root, "#invite-message").value;
    expect(message).toContain("Hi Alex!");
    expect(message).toContain("https://example.com/cloneME-Setup.exe");
    expect(message).toContain("cloneme://join?server=https%3A%2F%2Fmy-ai.onrender.com&code=WXYZ-2345-ABCD");
    expect(next().disabled).toBe(false);
    await click(m.root, "#wizard-next");

    expect(stepOf(m.root)).toBe("build");
    expect(next().disabled).toBe(true);
    await click(m.root, "#build-start");
    for (let i = 0; i < 40 && !$(m.root, "#manual-action"); i++) await new Promise((r) => setTimeout(r, 10));
    expect($(m.root, "#manual-action").textContent).toContain("Verify your voice with ElevenLabs");
    expect(m.root.querySelector('[data-stage="voiceVerification"]')!.classList.contains("waiting")).toBe(true);
    await click(m.root, "#manual-open");
    expect(m.bridge.openExternal).toHaveBeenCalledWith("https://elevenlabs.io/app/voice-lab");
    await click(m.root, "#manual-done");
    for (let i = 0; i < 40 && next().disabled; i++) await new Promise((r) => setTimeout(r, 10));
    expect(next().disabled).toBe(false);
    await click(m.root, "#wizard-next");

    expect(stepOf(m.root)).toBe("test");
    expect(next().disabled).toBe(true);
    expect($(m.root, "#wizard-reasons").textContent).toContain("test call");
    await click(m.root, "#test-call");
    await flush(20);
    expect(m.createCall).toHaveBeenCalled();
    await click(m.root, "#end");
    await flush();
    expect(stepOf(m.root)).toBe("test");
    expect(next().disabled).toBe(false);
    expect(next().textContent).toBe("Finish setup");
    await click(m.root, "#wizard-next");
    expect(m.db.onboarding.completedAt).toBe("done");
    expect(m.root.textContent).toContain("Talk to Sam Rivera");
    expect(m.root.querySelector("#setup-guide")).toBeTruthy();
  });

  it("resumes where the owner left off after a restart, and does not let them skip ahead", async () => {
    const first = mount();
    await toKeys(first);
    await addAllKeys(first);
    await click(first.root, "#wizard-next");
    await connect(first);
    await click(first.root, "#wizard-next");
    expect(stepOf(first.root)).toBe("voice");

    const { bridge, db } = fakeBridge();
    db.connected = true;
    db.serverUrl = "https://my-ai.onrender.com";
    db.onboarding.consentAcceptedAt = "now";
    db.onboarding.consentName = "Sam Rivera";
    db.onboarding.currentStep = "about";
    for (const v of ["tavus", "elevenlabs", "deepgram", "llm"] as const) db.savedKeys.add(v);
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    mountApp(root, { bridge: bridge as unknown as RendererBridge, createCall: vi.fn() as never, recorders: fakeRecorders({ seconds: 130, amp: 0.25 }).recorders, pollMs: 5 });
    await flush(20);
    expect(root.querySelector("#wizard")).toBeTruthy();
    expect(stepOf(root)).toBe("voice");
    const locked = [...root.querySelectorAll<HTMLButtonElement>(".step-link")].filter((b) => b.disabled).map((b) => b.dataset.step);
    expect(locked).toEqual(STEP_IDS.slice(4));
    const done = [...root.querySelectorAll(".step-link.done")].map((b) => (b as HTMLElement).dataset.step);
    expect(done).toEqual(["welcome", "keys", "server"]);
  });

  it("lets a finished owner reopen any step from the setup guide", async () => {
    const { bridge, db } = fakeBridge();
    db.connected = true;
    db.serverUrl = "https://my-ai.onrender.com";
    db.onboarding.consentAcceptedAt = "now";
    db.onboarding.consentName = "Sam Rivera";
    db.onboarding.completedAt = "done";
    db.build.started = true;
    db.build.verified = true;
    db.build.polls = 9;
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    mountApp(root, { bridge: bridge as unknown as RendererBridge, createCall: vi.fn() as never, recorders: fakeRecorders({ seconds: 1, amp: 0.2 }).recorders, pollMs: 5 });
    await flush(20);
    expect(root.textContent).toContain("Talk to Sam Rivera");
    await click(root, "#setup-guide");
    expect(root.querySelector("#wizard")).toBeTruthy();
    expect([...root.querySelectorAll<HTMLButtonElement>(".step-link")].some((b) => b.disabled)).toBe(false);
    await click(root, '[data-step="avoid"]');
    expect(stepOf(root)).toBe("avoid");
    await click(root, '[data-step="keys"]');
    expect(stepOf(root)).toBe("keys");
    await click(root, "#wizard-exit");
    expect(root.textContent).toContain("Talk to Sam Rivera");
  });

  it("shows a helpful message when the camera is blocked and allows a retry", { timeout: 30000 }, async () => {
    const m = mount();
    await toKeys(m);
    await addAllKeys(m);
    await click(m.root, "#wizard-next");
    await connect(m);
    await click(m.root, "#wizard-next");
    for (let i = 0; i < 14; i++) {
      await click(m.root, "#voice-record");
      await click(m.root, "#voice-stop");
      await click(m.root, "#voice-keep");
    }
    await click(m.root, "#wizard-next");
    m.rec.state.denyCamera = true;
    await click(m.root, "#video-retry").catch(() => undefined);
    m.rec.state.denyCamera = false;
    await click(m.root, '[data-step="voice"]');
    m.rec.state.denyCamera = true;
    await click(m.root, '[data-step="video"]');
    expect($(m.root, "#video-error").textContent).toContain("not allowed to use your microphone or camera");
    m.rec.state.denyCamera = false;
    await click(m.root, "#video-retry");
    expect($<HTMLButtonElement>(m.root, "#video-record").disabled).toBe(false);
  });

  it("accepts pasted invite lines on the sign-in screen", async () => {
    const m = mount();
    await flush();
    m.bridge.signIn.mockResolvedValue({ id: "p", name: "Alex Kim", role: "friend", relationship: "friend", aiBanner: true, ownerName: "Sam Rivera" });
    await type(m.root, "#code", "cloneme://join?server=https%3A%2F%2Fmy-ai.onrender.com&code=WXYZ-2345-ABCD");
    $(m.root, "form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(m.bridge.signIn).toHaveBeenCalledWith("WXYZ-2345-ABCD", "https://my-ai.onrender.com");
  });
});
