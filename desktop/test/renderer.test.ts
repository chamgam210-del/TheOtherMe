// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Person, RendererBridge, SessionInfo } from "../src/shared/bridge.js";
import { mountApp } from "../src/renderer/app.js";
import type { CallHandle, CreateCall } from "../src/renderer/call.js";

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const friend: Person = { id: "p1", name: "Alex Kim", role: "friend", relationship: "friend", aiBanner: true, ownerName: "Sam Rivera" };
const owner: Person = { id: "o1", name: "Sam Rivera", role: "owner", relationship: "self", aiBanner: false, ownerName: "Sam Rivera" };

function setup(initial: Person | null, over: Partial<RendererBridge> = {}) {
  const session: SessionInfo = { sessionId: "s1", conversationUrl: "mock://x", mock: true, greeting: "Hey", maxCallSeconds: 600, banner: { text: "AI version of Sam Rivera" } };
  const handle: CallHandle & { muted: boolean[]; cam: boolean[]; left: number } = {
    muted: [], cam: [], left: 0,
    setMuted(m) { this.muted.push(m); },
    setCameraOff(o) { this.cam.push(o); },
    async leave() { this.left++; },
  };
  const listeners: { signedOut?: (r: string) => void } = {};
  const bridge = {
    getState: vi.fn(async () => ({ apiBaseUrl: "http://x", person: initial, version: "1", serverUrl: null })),
    getLocalWizard: vi.fn(async () => ({})),
    getOnboarding: vi.fn(async () => ({ state: { skipped: {}, completedAt: "2026-01-01T00:00:00Z" }, facts: { ready: true } })),
    signIn: vi.fn(async (code: string) => {
      if (code !== "GOOD-CODE-1234") throw new Error("That invite code didn't work. Check it and try again.");
      return friend;
    }),
    signOut: vi.fn(async () => {}),
    startSession: vi.fn(async () => session),
    endSession: vi.fn(async () => {}),
    sendText: vi.fn(async (_id: string, text: string) => ({ reply: `echo: ${text}` })),
    onUpdate: vi.fn(),
    onSignedOut: vi.fn((fn: (r: string) => void) => { listeners.signedOut = fn; }),
    installUpdate: vi.fn(async () => {}),
    ...over,
  } as unknown as RendererBridge;
  const createCall: CreateCall = vi.fn(async (req) => { req.onState("live"); return handle; });
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  mountApp(root, { bridge, createCall });
  return { root, bridge, createCall, handle, listeners };
}

const $ = <T extends HTMLElement>(root: HTMLElement, sel: string) => root.querySelector(sel) as T;

describe("renderer", () => {
  beforeEach(() => vi.useRealTimers());

  it("shows the sign-in screen, rejects bad codes, then lands on home", async () => {
    const { root, bridge } = setup(null);
    await flush();
    expect(root.textContent).toContain("Enter the invite code");

    const input = $<HTMLInputElement>(root, "#code");
    input.value = "NOPE";
    $(root, "form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(root.querySelector(".error")!.textContent).toContain("didn't work");

    input.value = "GOOD-CODE-1234";
    $(root, "form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(bridge.signIn).toHaveBeenCalledWith("GOOD-CODE-1234", undefined);
    expect(root.textContent).toContain("Hi, Alex");
    expect(root.textContent).toContain("Talk to Sam Rivera");
    expect(root.querySelector("#owner-mode")).toBeNull();
  });

  it("remembers a signed-in person on launch", async () => {
    const { root } = setup(friend);
    await flush();
    expect(root.textContent).toContain("Hi, Alex");
  });

  it("runs a call: AI banner, mute, camera, text fallback, end", async () => {
    const { root, bridge, createCall, handle } = setup(friend);
    await flush();
    $(root, "#talk").click();
    await flush();
    expect(createCall).toHaveBeenCalledOnce();
    expect(root.querySelector("#ai-banner")!.textContent).toBe("AI version of Sam Rivera");

    $(root, "#mute").click();
    $(root, "#mute").click();
    expect(handle.muted).toEqual([true, false]);
    $(root, "#camera").click();
    expect(handle.cam).toEqual([true]);
    expect($(root, "#camera").textContent).toBe("Camera on");

    expect($(root, ".chat").hidden).toBe(true);
    $(root, "#chat-toggle").click();
    expect($(root, ".chat").hidden).toBe(false);
    $<HTMLInputElement>(root, "#chat-input").value = "hello";
    $(root, ".chat").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(root.querySelector(".msg.ai")!.textContent).toBe("echo: hello");

    $(root, "#end").click();
    await flush();
    expect(handle.left).toBe(1);
    expect(bridge.endSession).toHaveBeenCalledWith("s1");
    expect(root.textContent).toContain("Hi, Alex");
  });

  it("hides the banner when the server says so", async () => {
    const session: SessionInfo = { sessionId: "s2", conversationUrl: "mock://x", mock: true, greeting: "", maxCallSeconds: 60, banner: null };
    const { root } = setup(friend, { startSession: vi.fn(async () => session) });
    await flush();
    $(root, "#talk").click();
    await flush();
    expect(root.querySelector("#ai-banner")).toBeNull();
  });

  it("returns home with a message when the call cannot start", async () => {
    const { root } = setup(friend, { startSession: vi.fn(async () => { throw new Error("Too many calls right now."); }) });
    await flush();
    $(root, "#talk").click();
    await flush();
    expect(root.textContent).toContain("Hi, Alex");
    expect(root.querySelector(".toast")!.textContent).toContain("Too many calls");
  });

  it("returns to sign-in when access is revoked mid-session", async () => {
    const { root, listeners } = setup(friend);
    await flush();
    listeners.signedOut!("Your access has ended.");
    await flush();
    expect(root.textContent).toContain("Your access has ended.");
    expect(root.querySelector("#code")).not.toBeNull();
  });

  it("offers owner mode: overview, adding a person shows the invite code once", async () => {
    const people = [{ id: "o1", name: "Sam Rivera", role: "owner", relationship: "self", aiBanner: false, revoked: false, lastSeenAt: null, hasMemory: false }];
    const added = { person: { id: "n1", name: "Dana", role: "family", relationship: "sister", aiBanner: false, revoked: false, lastSeenAt: null, hasMemory: false }, inviteCode: "ABCD-EFGH-JKLM" };
    const { root, bridge } = setup(owner, {
      getVendors: vi.fn(async () => ({ mode: { tavus: "mock", elevenlabs: "mock", deepgram: "mock", llm: "mock" }, voice: { id: null, status: "none" }, replica: { id: null, status: "none" }, persona: { id: null }, readyForCalls: false })),
      listJobs: vi.fn(async () => ({ jobs: [] })),
      listPeople: vi.fn(async () => ({ people })),
      addPerson: vi.fn(async () => { people.push(added.person); return added; }),
      runTraining: vi.fn(async () => ({ started: true })),
    } as Partial<RendererBridge>);
    await flush();
    $(root, "#owner-mode").click();
    await flush();
    expect(root.textContent).toContain("Owner mode");
    expect(root.textContent).toContain("mock");
    $(root, "#run-training").click();
    await flush();
    expect(bridge.runTraining).toHaveBeenCalledWith(false);

    $(root, '[data-tab="people"]').click();
    await flush();
    $<HTMLInputElement>(root, "#new-name").value = "Dana";
    $<HTMLInputElement>(root, "#new-rel").value = "sister";
    $<HTMLSelectElement>(root, "#new-role").value = "family";
    $(root, "#add-person").click();
    await flush();
    expect(bridge.addPerson).toHaveBeenCalledWith({ name: "Dana", role: "family", relationship: "sister" });
    expect(root.querySelector(".reveal")!.textContent).toContain("ABCD-EFGH-JKLM");
    expect(root.querySelector(".people")!.textContent).toContain("Dana");
  });

  it("saves the profile with parsed avoid-topics and family", async () => {
    const saveProfile = vi.fn(async (p: any) => p);
    const { root } = setup(owner, {
      getProfile: vi.fn(async () => ({ displayName: "Sam Rivera", basics: "", family: [], avoidTopics: [] })),
      saveProfile,
    } as Partial<RendererBridge>);
    await flush();
    $(root, "#owner-mode").click();
    await flush();
    $(root, '[data-tab="profile"]').click();
    await flush();
    $<HTMLTextAreaElement>(root, "#p-avoid").value = "my ex\n\npolitics";
    $<HTMLTextAreaElement>(root, "#p-family").value = "Dana | sister | lives in Seattle\nbroken line";
    $(root, "#p-save").click();
    await flush();
    expect(saveProfile).toHaveBeenCalledWith(expect.objectContaining({
      avoidTopics: ["my ex", "politics"],
      family: [{ name: "Dana", relationship: "sister", notes: "lives in Seattle" }],
    }));
  });
});
