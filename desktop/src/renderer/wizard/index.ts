import type { KeysStatus, LocalWizard, OnboardingData, RendererBridge, ServerCheck } from "../../shared/bridge.js";
import { canGoto, createWizard, emptyFacts, progress, reduce, STEP_IDS, STEP_TITLES, validateStep, OPTIONAL_STEPS, type StepId, type WizardFacts, type WizardState } from "../../shared/wizard.js";
import { clear, errorText, h, put, swap } from "../dom.js";
import type { Recorders } from "../media.js";
import { STEP_RENDERERS } from "./steps.js";
import type { StepCtx } from "./types.js";
import { progressBar } from "./ui.js";

export interface WizardDeps {
  bridge: RendererBridge;
  recorders: Recorders;
  say(message: string, kind?: "error" | "info"): void;
  /** Starts a call with the owner's own AI self and resolves once the call screen has been left. */
  startTestCall(): Promise<void>;
  /** Leaves the wizard without finishing (progress is already saved). */
  onExit(connected: boolean): void | Promise<void>;
  onFinished(): void;
  /** Open every step freely, as in owner mode after setup. */
  freeNavigation?: boolean;
  startStep?: StepId;
  pollMs?: number;
}

const isLoopback = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);

export async function mountWizard(shell: HTMLElement, deps: WizardDeps): Promise<void> {
  const { bridge } = deps;
  let data = null as OnboardingData | null;
  let keys: KeysStatus | null = null;
  let local: LocalWizard = {};
  let serverUrl = "";
  let serverCheck: ServerCheck | null = null;
  let ownerName = "";
  let overrides: Partial<WizardFacts> = {};
  let state: WizardState;
  let cleanups: (() => void)[] = [];
  let finishing = false;

  async function load() {
    const [appState, localState, keyState, onboarding] = await Promise.all([
      bridge.getState(),
      bridge.getLocalWizard().catch(() => ({}) as LocalWizard),
      bridge.getKeysStatus().catch(() => null),
      bridge.getOnboarding().catch(() => null),
    ]);
    local = localState;
    keys = keyState;
    data = onboarding;
    serverUrl = appState.serverUrl ?? serverUrl;
    ownerName = appState.person?.name ?? data?.state.consentName ?? local.consentName ?? "";
  }

  function derive(): WizardFacts {
    const f = emptyFacts();
    const connected = data !== null;
    const consentFromServer = data?.state.consentAcceptedAt ? { accepted: true, name: data.state.consentName ?? "" } : null;
    f.consent = consentFromServer ?? { accepted: Boolean(local.consentAccepted), name: local.consentName ?? "" };
    if (keys) {
      for (const v of ["tavus", "elevenlabs", "deepgram", "llm"] as const) {
        const s = keys.vendors[v];
        f.keys[v] = (s.saved && s.check?.ok !== false) || s.staged;
      }
    }
    f.serverConnected = connected;
    f.serverCheck = serverCheck
      ? { reachable: serverCheck.reachable, https: serverCheck.https, persistentStorage: serverCheck.persistentStorage, isCloneme: serverCheck.isCloneme }
      : connected
        ? { reachable: true, https: serverUrl.startsWith("https://") || isLoopback(serverUrl), persistentStorage: true, isCloneme: true }
        : null;
    if (data) {
      const d = data.facts;
      f.voiceSeconds = d.voiceSeconds;
      f.replicaVideoSeconds = d.replicaVideo ? (d.replicaVideo.durationSec ?? 120) : null;
      f.consentVideoSeconds = d.consentVideo ? (d.consentVideo.durationSec ?? 15) : null;
      f.profile = { displayName: d.profile.displayName, answers: d.profile.answers };
      f.avoidTopics = d.profile.avoidTopics;
      f.avoidNone = Boolean(data.state.avoidNone);
      f.people = d.people;
      f.inviteSkipped = Boolean(data.state.skipped.invite);
      f.buildReady = d.ready;
      f.testCalls = d.testCalls;
    }
    return { ...f, ...overrides };
  }

  const free = () => Boolean(deps.freeNavigation || data?.state.completedAt);

  await load();
  if (serverUrl && data) void checkServerInBackground();
  state = createWizard(deps.startStep ?? data?.state.currentStep ?? local.currentStep, derive(), free());
  if (deps.startStep) state = { ...state, current: deps.startStep };

  const stepper = h("nav", { class: "stepper", "aria-label": "Setup steps" });
  const body = h("div", { class: "step-body", id: "step-body" });
  const heading = h("div", { class: "step-heading" });
  const footer = h("footer", { class: "wizard-footer" });
  clear(shell);
  put(shell, 
    h("div", { class: "wizard", id: "wizard" },
      h("aside", { class: "wizard-side" }, stepper),
      h("main", { class: "wizard-main" }, heading, body, footer),
    ),
  );

  const ctx: StepCtx = {
    bridge,
    recorders: deps.recorders,
    say: deps.say,
    facts: () => state.facts,
    data: () => data,
    keys: () => keys,
    local: () => local,
    serverUrl: () => serverUrl,
    ownerName: () => ownerName,
    async refresh() {
      await load();
      state = reduce({ ...state, freeNavigation: free() }, { type: "facts", facts: derive() });
      renderChrome();
    },
    draftConsent(consent) {
      overrides = { ...overrides, consent };
      ctx.invalidate();
    },
    setServerCheck(check, url) {
      serverCheck = check;
      if (url) serverUrl = url;
      ctx.invalidate();
    },
    invalidate() {
      state = reduce(state, { type: "facts", facts: derive() });
      renderChrome();
    },
    onCleanup: (fn) => void cleanups.push(fn),
    startTestCall: deps.startTestCall,
    pollMs: deps.pollMs ?? 2500,
  };

  async function checkServerInBackground() {
    const check = await bridge.checkServer(serverUrl).catch(() => null);
    if (!check) return;
    serverCheck = check;
    ctx.invalidate();
  }

  async function persistStep(step: StepId) {
    await bridge.saveLocalWizard({ currentStep: step }).catch(() => undefined);
    if (data) await bridge.saveOnboarding({ currentStep: step }).catch(() => undefined);
  }

  function renderChrome() {
    const { done, total, percent } = progress(state.facts);
    clear(stepper);
    put(stepper, 
      h("h2", {}, "Set up your AI self"),
      progressBar(percent / 100, `${done} of ${total} steps done`, "wizard-progress"),
      h("ol", {}, ...STEP_IDS.map((id, i) => {
        const v = validateStep(id, state.facts);
        const reachable = canGoto(state, id);
        const classes = ["step-link", id === state.current ? "current" : "", v.ok && !OPTIONAL_STEPS.includes(id) ? "done" : "", reachable ? "" : "locked"].filter(Boolean).join(" ");
        return h("li", {},
          h("button", { class: classes, "data-step": id, disabled: !reachable, "aria-current": id === state.current ? "step" : undefined, on: { click: () => void go({ type: "goto", step: id }) } },
            h("span", { class: "num" }, v.ok && !OPTIONAL_STEPS.includes(id) ? "\u2713" : String(i + 1)),
            h("span", {}, STEP_TITLES[id], OPTIONAL_STEPS.includes(id) ? h("small", { class: "muted" }, " optional") : null)));
      })),
      h("div", { class: "side-actions" },
        h("p", { class: "muted" }, "Your progress is saved automatically."),
        h("button", { class: "ghost", id: "wizard-exit", on: { click: () => leave() } }, data ? "Close setup guide" : "Back to sign in")),
    );

    const index = STEP_IDS.indexOf(state.current);
    const v = validateStep(state.current, state.facts);
    const last = index === STEP_IDS.length - 1;
    swap(heading, h("p", { class: "eyebrow" }, `Step ${index + 1} of ${STEP_IDS.length}`), h("h1", {}, STEP_TITLES[state.current]));
    clear(footer);
    put(footer, 
      h("button", { id: "wizard-back", hidden: index === 0, on: { click: () => void go({ type: "back" }) } }, "Back"),
      h("div", { class: "footer-note", id: "wizard-reasons" },
        ...v.reasons.map((r) => h("p", { class: "reason" }, r)),
        ...v.warnings.map((w) => h("p", { class: "warning" }, w))),
      h("button", { class: "primary", id: "wizard-next", disabled: !v.ok || finishing, on: { click: () => void (last ? finish() : next()) } }, last ? "Finish setup" : "Next"),
    );
  }

  function leave() {
    runCleanups();
    deps.onExit(data !== null);
  }

  function runCleanups() {
    const fns = cleanups;
    cleanups = [];
    for (const fn of fns) fn();
  }

  async function renderStep() {
    runCleanups();
    clear(body);
    const step = state.current;
    try {
      await STEP_RENDERERS[step](body, ctx);
    } catch (err) {
      if (state.current === step) deps.say(errorText(err));
    }
  }

  async function next() {
    if (state.current === "welcome") {
      const { accepted, name } = state.facts.consent;
      await bridge.saveLocalWizard({ consentAccepted: accepted, consentName: name.trim() }).catch(() => undefined);
      if (data) await bridge.saveOnboarding({ consentAccepted: accepted, consentName: name.trim() }).catch((e) => deps.say(errorText(e)));
      delete overrides.consent;
    }
    await go({ type: "next" });
  }

  async function go(action: Parameters<typeof reduce>[1]) {
    const before = state.current;
    state = reduce(state, action);
    if (state.current !== before) {
      await persistStep(state.current);
      await ctx.refresh().catch(() => undefined);
      renderChrome();
      await renderStep();
      body.scrollTop = 0;
    } else {
      renderChrome();
    }
  }

  async function finish() {
    finishing = true;
    renderChrome();
    try {
      await bridge.saveOnboarding({ completed: true });
      runCleanups();
      deps.onFinished();
    } catch (err) {
      finishing = false;
      deps.say(errorText(err));
      renderChrome();
    }
  }

  renderChrome();
  await renderStep();
  void persistStep(state.current);
}
