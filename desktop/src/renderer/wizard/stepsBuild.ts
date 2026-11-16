import type { BuildStage, BuildStatus } from "../../shared/bridge.js";
import { clear, errorText, h, put, swap } from "../dom.js";
import type { StepRenderer } from "./types.js";
import { busy, callout, progressBar, section, steps } from "./ui.js";

const ICON: Record<BuildStage["status"], string> = { pending: "\u25CB", running: "\u2026", done: "\u2713", waiting: "!", failed: "\u2717" };

export const buildStep: StepRenderer = async (el, ctx) => {
  let status: BuildStatus | null = null;
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  ctx.onCleanup(() => {
    alive = false;
    if (timer) clearTimeout(timer);
  });

  const stages = h("div", { id: "build-stages" });
  const actions = h("div", { id: "build-actions", class: "row wrap" });
  const manual = h("div", { id: "build-manual" });
  const message = h("div", { id: "build-message", "aria-live": "polite" });

  async function apply(next: BuildStatus) {
    status = next;
    render();
    await ctx.refresh();
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    if (!alive || !status || !status.started || status.ready) return;
    timer = setTimeout(async () => {
      try {
        await apply(await ctx.bridge.getBuild());
        swap(message, );
      } catch (err) {
        if (alive) swap(message, callout("error", errorText(err)));
      }
      schedule();
    }, ctx.pollMs);
  }

  const act = (label: string, id: string, run: () => Promise<BuildStatus>, primary = false) => {
    const b = h("button", { id, type: "button", class: primary ? "primary" : "" }, label);
    b.addEventListener("click", () =>
      busy(b, ctx.say, async () => {
        swap(message, );
        try {
          await apply(await run());
          schedule();
        } catch (err) {
          swap(message, callout("error", errorText(err)));
        }
      }, errorText),
    );
    return b;
  };

  function render() {
    if (!status) return;
    const done = status.stages.filter((s) => s.status === "done").length;
    clear(stages);
    put(stages, 
      progressBar(done / status.stages.length, `${done} of ${status.stages.length} stages complete`, "build-progress"),
      h("ul", { class: "plain stages" }, ...status.stages.map((s) =>
        h("li", { class: `stage ${s.status}`, "data-stage": s.id },
          h("span", { class: "mark" }, ICON[s.status]),
          h("div", {}, h("strong", {}, s.label), h("div", { class: "muted" }, s.detail),
            s.status === "failed" ? act("Try this stage again", `retry-${s.id}`, () => ctx.bridge.retryBuildStage(s.id)) : null)))),
    );
    clear(actions);
    if (!status.started) put(actions, act("Start building my AI self", "build-start", () => ctx.bridge.startBuild(), true));
    clear(manual);
    if (status.manualAction) {
      const m = status.manualAction;
      put(manual, h("div", { class: "callout warn", id: "manual-action" },
        h("strong", {}, m.title),
        steps(m.steps),
        h("div", { class: "row wrap" },
          h("button", { type: "button", id: "manual-open", on: { click: () => void ctx.bridge.openExternal(m.link).catch((e) => ctx.say(errorText(e))) } }, "Open ElevenLabs"),
          act("I've verified my voice", "manual-done", () => ctx.bridge.confirmVoiceVerified(), true))));
    }
    if (status.ready) {
      put(manual, callout("ok", "Your AI self is built. Next, try a call with it yourself."));
    }
    if (status.mock) {
      put(manual, callout("info", "This server is in test mode, so the stages complete with placeholders. Add your keys and turn off MOCK_MODE for the real thing."));
    }
  }

  put(el, 
    section("Build your AI self",
      h("p", {}, "The app now sends your recordings to the services and builds everything. It runs on your server, so you can close the app while it works; come back to this step to see progress. The voice and face usually take 10 to 30 minutes."),
      stages, actions, manual, message),
  );
  try {
    await apply(await ctx.bridge.getBuild());
    schedule();
  } catch (err) {
    swap(message, callout("error", errorText(err)));
  }
};

export const testStep: StepRenderer = (el, ctx) => {
  const ready = ctx.data()?.facts.ready ?? false;
  const calls = ctx.facts().testCalls;
  const start = h("button", { class: "primary big", id: "test-call", type: "button", disabled: !ready }, calls ? "Call my AI self again" : "Start a test call");
  start.addEventListener("click", () => busy(start, ctx.say, () => ctx.startTestCall(), errorText));
  put(el, 
    section("Meet your AI self",
      h("p", {}, "Start a short call with the AI version of you, exactly as your friends will see it. Say hello, ask it something only you would know, and see how it feels. If something is off, go back to About you or More material and refine it later; you can rebuild at any time."),
      calls ? callout("ok", `You have made ${calls} test call${calls === 1 ? "" : "s"}. Press Finish setup when you are happy.`) : null,
      !ready ? callout("warn", "Your AI self is not ready yet. Finish the Build step first.") : null,
      h("div", { class: "row" }, start)),
  );
};
