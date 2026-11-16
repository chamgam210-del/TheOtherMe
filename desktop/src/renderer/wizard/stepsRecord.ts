import { analyzeAudio, encodeWav, MIN_CLIP_SECONDS, type AudioQuality } from "../../shared/audioAnalysis.js";
import type { MediaPurpose } from "../../shared/bridge.js";
import { CONSENT_TEMPLATE, READINGS, STORIES, VIDEO_SCRIPT, VOICE_PROMPTS, type VoicePrompt } from "../../shared/prompts.js";
import { analyzeFrame, type LightingReport } from "../../shared/videoAnalysis.js";
import { CONSENT_MIN_SECONDS, VIDEO_MIN_SECONDS, VOICE_TARGET_SECONDS } from "../../shared/wizard.js";
import { clear, errorText, h, put, swap } from "../dom.js";
import { sampleFrame, type AudioRecorder, type VideoRecorder } from "../media.js";
import type { StepCtx, StepRenderer } from "./types.js";
import { callout, fmtDuration, progressBar, section, steps } from "./ui.js";

const MAX_AUDIO_SECONDS = 8 * 60;
const blobUrl = (data: BlobPart, type: string) => (typeof URL.createObjectURL === "function" ? URL.createObjectURL(new Blob([data], { type })) : "");

// ---------------------------------------------------------------------------------------------------------------- voice

export const voiceStep: StepRenderer = async (el, ctx) => {
  const clips = () => new Map((ctx.data()?.facts.voiceClips ?? []).filter((c) => c.promptId).map((c) => [c.promptId!, c]));
  let selected: VoicePrompt = VOICE_PROMPTS.find((p) => !clips().has(p.id)) ?? VOICE_PROMPTS[0]!;
  let recorder: AudioRecorder | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let url = "";
  let alive = true;
  ctx.onCleanup(() => {
    alive = false;
    if (timer) clearInterval(timer);
    recorder?.close();
    if (url) URL.revokeObjectURL?.(url);
  });

  const total = h("div", { id: "voice-total" });
  const list = h("div", { class: "prompt-list", id: "prompt-list" });
  const stage = h("div", { class: "recorder", id: "voice-stage" });
  const meterFill = h("div", { class: "meter-fill" });
  const clipLamp = h("span", { class: "lamp", id: "clip-lamp", hidden: true }, "Too loud");
  const meter = h("div", { class: "meter", "aria-label": "Microphone level" }, meterFill);

  put(el, 
    section("Record your voice",
      h("p", {}, "Your voice clone is made from about 30 minutes of you speaking naturally. Read the passages aloud and answer the story questions as if you were talking to a friend. Each clip is checked right away for volume, background noise and clipping, and you can redo any of them."),
      steps(["Sit in a quiet room, close windows and turn off fans and notifications.", "Keep the microphone about a hand's width from your mouth and speak at your normal volume.", "Read or answer each prompt in one go. Stop after you have finished it."]),
      total),
    h("div", { class: "split" }, list, stage),
  );

  function renderTotal() {
    const seconds = ctx.facts().voiceSeconds;
    clear(total);
    put(total, 
      progressBar(seconds / VOICE_TARGET_SECONDS, `${fmtDuration(seconds)} of ${fmtDuration(VOICE_TARGET_SECONDS)} recorded${seconds >= VOICE_TARGET_SECONDS ? ". You have enough. More is welcome." : ""}`, "voice-progress"),
      h("div", { class: "row" },
        h("button", { id: "voice-import", type: "button", on: { click: async (e) => {
          const b = e.currentTarget as HTMLButtonElement;
          b.disabled = true;
          try {
            const res = await ctx.bridge.uploadExistingVoice();
            if (res.uploaded.length) ctx.say(`Added ${res.uploaded.length} recording${res.uploaded.length === 1 ? "" : "s"}.`, "info");
            if (res.failed.length) ctx.say(`${res.failed[0]!.name}: ${res.failed[0]!.message}`);
            await ctx.refresh();
            renderAll();
          } catch (err) {
            ctx.say(errorText(err));
          }
          b.disabled = false;
        } } }, "I already have recordings: add them"),
        h("span", { class: "muted" }, "Long, clean recordings of you alone work well. Length of compressed files is estimated.")),
    );
  }

  function renderList() {
    clear(list);
    const have = clips();
    const group = (title: string, prompts: VoicePrompt[]) => {
      put(list, h("h4", {}, title));
      for (const p of prompts) {
        const clip = have.get(p.id);
        put(list, 
          h("button", { class: `prompt-item${p.id === selected.id ? " active" : ""}${clip ? " done" : ""}`, "data-prompt": p.id, type: "button", on: { click: () => { if (!recording()) { selected = p; renderAll(); } } } },
            h("span", { class: "mark" }, clip ? "\u2713" : "\u25CB"), h("span", {}, p.title), h("small", { class: "muted" }, clip ? fmtDuration(clip.durationSec) : `~${fmtDuration(p.targetSec)}`)),
        );
      }
    };
    group("Read aloud", READINGS);
    group("Tell me about…", STORIES);
  }

  const recording = () => stage.dataset.state === "recording";

  async function ensureRecorder(): Promise<AudioRecorder> {
    if (recorder) return recorder;
    const r = await ctx.recorders.createAudioRecorder();
    if (!alive) {
      r.close();
      throw new Error("closed");
    }
    r.onLevel(({ peak, rms, clipping }) => {
      meterFill.style.width = `${Math.min(100, Math.round(Math.max(rms * 4, peak * 0.6) * 100))}%`;
      clipLamp.hidden = !clipping;
    });
    recorder = r;
    return r;
  }

  function renderStage(state: "idle" | "recording" | "review", review?: { quality: AudioQuality; wav: Uint8Array }) {
    clear(stage);
    stage.dataset.state = state;
    if (url) URL.revokeObjectURL?.(url);
    url = "";
    const p = selected;
    const clip = clips().get(p.id);
    put(stage, 
      h("h3", {}, p.title),
      h("div", { class: `script ${p.kind}`, id: "voice-script" }, p.text),
      h("div", { class: "meter-row" }, meter, clipLamp),
    );
    if (state === "idle") {
      const err = h("div", { id: "voice-error" });
      const start = h("button", { class: "primary", id: "voice-record", type: "button" }, clip ? "Record again" : "Start recording");
      start.addEventListener("click", async () => {
        start.disabled = true;
        try {
          const r = await ensureRecorder();
          r.start();
          beginTimer(r);
        } catch (e) {
          start.disabled = false;
          if (alive) swap(err, callout("error", errorText(e)));
        }
      });
      put(stage, 
        clip ? callout("ok", `Recorded (${fmtDuration(clip.durationSec)}). Recording again replaces it.`) : null,
        h("div", { class: "row" }, start, h("span", { class: "muted" }, `Aim for about ${fmtDuration(p.targetSec)}.`)),
        err,
      );
      void ensureRecorder().catch((e) => alive && swap(err, callout("error", errorText(e))));
    } else if (state === "recording") {
      const clock = h("span", { class: "clock", id: "voice-clock" }, "0:00");
      const stop = h("button", { class: "danger", id: "voice-stop", type: "button" }, "Stop");
      stop.addEventListener("click", () => finishTake());
      put(stage, h("div", { class: "row" }, h("span", { class: "rec-dot" }), clock, stop));
      clockEl = clock;
    } else if (review) {
      const { quality, wav } = review;
      const tone = quality.verdict === "ok" ? "ok" : quality.verdict === "warn" ? "warn" : "error";
      url = blobUrl(wav as BlobPart, "audio/wav");
      const keep = h("button", { class: "primary", id: "voice-keep", type: "button", disabled: quality.verdict === "fail" }, quality.verdict === "warn" ? "Keep anyway" : "Keep this clip");
      keep.addEventListener("click", async () => {
        keep.disabled = true;
        try {
          await ctx.bridge.uploadRecording({ purpose: "voice", filename: `${p.id}.wav`, mimeType: "audio/wav", data: wav, durationSec: quality.durationSec, promptId: p.id, promptKind: p.kind, quality: { ...quality } });
          await ctx.refresh();
          selected = VOICE_PROMPTS.find((x) => !clips().has(x.id)) ?? p;
          renderAll();
        } catch (e) {
          keep.disabled = false;
          ctx.say(errorText(e));
        }
      });
      put(stage, 
        callout(tone, h("strong", {}, quality.verdict === "ok" ? "Sounds good" : quality.verdict === "warn" ? "Usable, but could be better" : "Please record this one again"),
          quality.issues.length ? h("ul", {}, ...quality.issues.map((i) => h("li", {}, i))) : null,
          quality.advice.length ? h("ul", { class: "advice" }, ...quality.advice.map((a) => h("li", {}, a))) : null),
        h("p", { class: "muted", id: "voice-stats" }, `${fmtDuration(quality.durationSec)} long, level ${quality.speechDb.toFixed(0)} dB, background ${quality.noiseFloorDb.toFixed(0)} dB, clipping ${quality.clippingPercent.toFixed(1)}%`),
        url ? h("audio", { controls: true, src: url, id: "voice-playback" }) : null,
        h("div", { class: "row" }, keep, h("button", { id: "voice-redo", type: "button", on: { click: () => renderStage("idle") } }, "Re-record")),
      );
    }
  }

  let clockEl: HTMLElement | null = null;
  function beginTimer(r: AudioRecorder) {
    const started = Date.now();
    renderStage("recording");
    timer = setInterval(() => {
      const secs = (Date.now() - started) / 1000;
      if (clockEl) clockEl.textContent = fmtDuration(secs);
      if (secs >= MAX_AUDIO_SECONDS) finishTake();
    }, 250);
    void r;
  }

  function finishTake() {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (!recorder) return renderStage("idle");
    const samples = recorder.stop();
    const quality = analyzeAudio(samples, recorder.sampleRate, { minSeconds: MIN_CLIP_SECONDS });
    renderStage("review", { quality, wav: encodeWav([samples], recorder.sampleRate) });
  }

  function renderAll() {
    renderTotal();
    renderList();
    renderStage("idle");
  }
  renderAll();
};

// ---------------------------------------------------------------------------------------------------------------- video

interface VideoStepOptions {
  purpose: Extract<MediaPurpose, "replica" | "consent">;
  promptId: string;
  filename: string;
  minSec: number;
  targetSec: number;
  heading: string;
  intro: (ctx: StepCtx) => (Node | null)[];
  script: (ctx: StepCtx) => { label: string; text: string; exact?: boolean };
  existing: (ctx: StepCtx) => { durationSec?: number } | null;
  tips: string[];
}

const FRAMING_TIPS = [
  "Put your head and shoulders in the oval, eyes about a third of the way down from the top.",
  "Raise the camera to eye level and look at the lens, not at the screen.",
  "Face a window or lamp so light falls on your face. Avoid a bright window behind you.",
  "Use a plain background, and take off hats and anything that casts shadows on your face.",
];

function videoStep(opts: VideoStepOptions): StepRenderer {
  return async (el, ctx) => {
    let recorder: VideoRecorder | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let lightTimer: ReturnType<typeof setInterval> | undefined;
    let url = "";
    let alive = true;
    const close = () => {
      if (timer) clearInterval(timer);
      if (lightTimer) clearInterval(lightTimer);
      timer = lightTimer = undefined;
      recorder?.close();
      recorder = null;
    };
    ctx.onCleanup(() => {
      alive = false;
      close();
      if (url) URL.revokeObjectURL?.(url);
    });

    const stage = h("div", { class: "recorder", id: `${opts.purpose}-stage` });
    const script = opts.script(ctx);
    put(el, section(opts.heading, ...opts.intro(ctx), steps(opts.tips)), stage);

    const existing = opts.existing(ctx);

    async function renderLive() {
      close();
      if (url) URL.revokeObjectURL?.(url);
      url = "";
      clear(stage);
      stage.dataset.state = "idle";
      const preview = h("video", { class: "preview", id: "video-preview", autoplay: true, muted: true, playsInline: true });
      const lighting = h("div", { id: "lighting", class: "lighting" }, callout("info", "Starting your camera…"));
      const err = h("div", { id: "video-error" });
      const start = h("button", { class: "primary", id: "video-record", type: "button", disabled: true }, existing ? "Record again" : "Start recording");
      const scriptBox = h("div", { class: `script teleprompter${script.exact ? " exact" : ""}`, id: `${opts.purpose}-script` }, h("small", { class: "muted" }, script.label), h("div", { class: "script-text" }, script.text));
      put(stage, 
        existing ? callout("ok", `You already have a recording${existing.durationSec ? ` (${fmtDuration(existing.durationSec)})` : ""}. Recording again replaces it.`) : null,
        h("div", { class: "video-grid" },
          h("div", { class: "video-wrap" }, preview, h("div", { class: "oval", "aria-hidden": "true" }), h("div", { class: "oval-caption" }, "Face inside the oval, look at the lens")),
          scriptBox),
        lighting,
        h("div", { class: "row" }, start),
        err,
      );
      try {
        const r = await ctx.recorders.createVideoRecorder();
        if (!alive) {
          r.close();
          return;
        }
        recorder = r;
        preview.srcObject = r.stream;
        void Promise.resolve(preview.play?.()).catch(() => undefined);
        start.disabled = false;
        const check = () => {
          const frame = sampleFrame(preview);
          if (!frame) return;
          swap(lighting, lightingView(analyzeFrame(frame.rgba, frame.width, frame.height)));
        };
        lightTimer = setInterval(check, 1000);
        setTimeout(check, 400);
        start.addEventListener("click", () => beginRecording(r));
      } catch (e) {
        swap(lighting, );
        swap(err, callout("error", errorText(e)), h("button", { type: "button", id: "video-retry", on: { click: () => void renderLive() } }, "Try again"));
      }
    }

    function beginRecording(r: VideoRecorder) {
      r.start();
      stage.dataset.state = "recording";
      const started = Date.now();
      const clock = h("span", { class: "clock", id: "video-clock" }, "0:00");
      const label = `Aim for about ${fmtDuration(opts.targetSec)}`;
      let fill = progressBar(0, label, "video-progress");
      const stop = h("button", { class: "danger", id: "video-stop", type: "button" }, "Stop");
      stop.addEventListener("click", () => void finishTake(r));
      const controls = h("div", { class: "recording-bar" }, h("div", { class: "row" }, h("span", { class: "rec-dot" }), clock, stop), fill);
      stage.querySelector(".row")?.replaceWith(controls);
      timer = setInterval(() => {
        const secs = (Date.now() - started) / 1000;
        clock.textContent = fmtDuration(secs);
        const next = progressBar(secs / opts.targetSec, label, "video-progress");
        fill.replaceWith(next);
        fill = next;
        if (secs >= opts.targetSec * 2) void finishTake(r);
      }, 500);
    }

    async function finishTake(r: VideoRecorder) {
      if (timer) clearInterval(timer);
      timer = undefined;
      try {
        const take = await r.stop();
        close();
        renderReview(take);
      } catch (e) {
        ctx.say(errorText(e));
        void renderLive();
      }
    }

    function renderReview(take: { data: Uint8Array; mimeType: string; durationSec: number }) {
      clear(stage);
      stage.dataset.state = "review";
      url = blobUrl(take.data as BlobPart, take.mimeType);
      const tooShort = take.durationSec < opts.minSec;
      const use = h("button", { class: "primary", id: "video-use", type: "button", disabled: tooShort }, "Use this take");
      use.addEventListener("click", async () => {
        use.disabled = true;
        try {
          await ctx.bridge.uploadRecording({ purpose: opts.purpose, filename: opts.filename, mimeType: take.mimeType, data: take.data, durationSec: take.durationSec, promptId: opts.promptId });
          await ctx.refresh();
          await renderDone(take.durationSec);
        } catch (e) {
          use.disabled = false;
          ctx.say(errorText(e));
        }
      });
      put(stage, 
        tooShort
          ? callout("error", `That take is ${fmtDuration(take.durationSec)}, which is too short. It needs to be at least ${fmtDuration(opts.minSec)}. Please record it again.`)
          : callout("info", "Watch it back. Check that your face is clear, the sound is good and you said everything."),
        url ? h("video", { controls: true, src: url, id: "video-playback", class: "playback" }) : null,
        h("div", { class: "row" }, use, h("button", { id: "video-retake", type: "button", on: { click: () => void renderLive() } }, "Re-take")),
      );
    }

    async function renderDone(durationSec: number, already = false) {
      clear(stage);
      stage.dataset.state = "done";
      put(stage, 
        callout("ok", already ? `You already have a recording${durationSec ? ` (${fmtDuration(durationSec)})` : ""}. Continue, or record it again to replace it.` : `Saved (${fmtDuration(durationSec)}). You can continue, or record it again if you want a better take.`),
        h("div", { class: "row" }, h("button", { id: "video-again", type: "button", on: { click: () => void renderLive() } }, "Record again")),
      );
    }

    if (existing) {
      await renderDone(existing.durationSec ?? 0, true);
    } else {
      await renderLive();
    }
  };
}

function lightingView(r: LightingReport) {
  const tone = r.verdict === "ok" ? "ok" : r.verdict === "warn" ? "warn" : "error";
  return callout(tone, h("strong", {}, r.verdict === "ok" ? "Lighting looks good" : r.verdict === "warn" ? "Lighting is okay, could be better" : "Fix the lighting before recording"),
    r.issues.length ? h("ul", {}, ...r.issues.map((i) => h("li", {}, i))) : null,
    r.advice.length ? h("ul", { class: "advice" }, ...r.advice.map((a) => h("li", {}, a))) : null);
}

export const videoRecordStep = videoStep({
  purpose: "replica",
  promptId: "replica-training",
  filename: "training-video.webm",
  minSec: VIDEO_MIN_SECONDS,
  targetSec: 120,
  heading: "Record your training video",
  intro: () => [h("p", {}, "Tavus builds your on-screen face from about two minutes of you talking to the camera. Read the script on the right naturally, with your usual expressions. Pause and breathe the way you normally would.")],
  script: () => ({ label: "Read this naturally (you can ad-lib)", text: VIDEO_SCRIPT }),
  existing: (ctx) => ctx.data()?.facts.replicaVideo ?? null,
  tips: FRAMING_TIPS,
});

export const consentStep = videoStep({
  purpose: "consent",
  promptId: "consent-statement",
  filename: "consent-video.webm",
  minSec: CONSENT_MIN_SECONDS,
  targetSec: 20,
  heading: "Record your consent video",
  intro: () => [h("p", {}, "Tavus only creates a replica of someone who says, on camera, that they agree. Record yourself saying the statement below exactly as written, clearly and in one take, in the same place and lighting as your training video.")],
  script: (ctx) => {
    const name = ctx.facts().consent.name || ctx.data()?.state.consentName || ctx.ownerName();
    return { label: "Say exactly this", text: CONSENT_TEMPLATE(name), exact: true };
  },
  existing: (ctx) => ctx.data()?.facts.consentVideo ?? null,
  tips: ["Say the statement word for word, including your name.", ...FRAMING_TIPS.slice(0, 2), "Start and end with a short pause, and keep the recording to one take."],
});
