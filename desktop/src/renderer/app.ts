import type { Fact, ManagedPerson, MediaPurpose, Person, Profile, RendererBridge, SessionInfo } from "../shared/bridge.js";
import type { CreateCall, CallHandle } from "./call.js";
import { clear, errorText, h } from "./dom.js";
import { parseInvite } from "../shared/invite.js";
import { browserRecorders, type Recorders } from "./media.js";
import { mountWizard } from "./wizard/index.js";
import type { StepId } from "../shared/wizard.js";

export interface AppDeps {
  bridge: RendererBridge;
  createCall: CreateCall;
  recorders?: Recorders;
  /** Poll interval for live build status, in milliseconds. */
  pollMs?: number;
}

type OwnerTab = "overview" | "upload" | "profile" | "style" | "people";

const PURPOSE_HELP: Record<MediaPurpose, { label: string; help: string }> = {
  voice: { label: "Voice samples", help: "30+ minutes of your clean speech (audio). Builds your ElevenLabs voice clone." },
  replica: { label: "Face training video", help: "About 2 minutes of clean on-camera video. Builds your Tavus face replica." },
  consent: { label: "Consent video", help: "A short video of you speaking the Tavus consent statement." },
  training: { label: "Style training", help: "Audio, video or text in your voice (chats, emails, notes). Teaches how you talk." },
};

const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const pct = (n: number) => `${Math.round(n * 100)}%`;

export function mountApp(root: HTMLElement, deps: AppDeps) {
  const { bridge, createCall } = deps;
  const recorders = deps.recorders ?? browserRecorders;
  let person: Person | null = null;
  let activeCall: { handle: CallHandle; session: SessionInfo; timer?: ReturnType<typeof setInterval> } | null = null;

  const shell = h("div", { class: "shell" });
  const toast = h("div", { class: "toast", role: "status", hidden: true });
  const updateBar = h("div", { class: "update-bar", hidden: true });
  root.append(updateBar, shell, toast);

  function say(message: string, kind: "error" | "info" = "error") {
    toast.textContent = message;
    toast.className = `toast ${kind}`;
    toast.hidden = false;
    setTimeout(() => (toast.hidden = true), 6000);
  }

  bridge.onUpdate((s) => {
    if (s.state === "ready") {
      clear(updateBar);
      updateBar.append(`Update ${s.version ?? ""} is ready. `, h("button", { class: "link", on: { click: () => void bridge.installUpdate() } }, "Restart to install"));
      updateBar.hidden = false;
    } else if (s.state === "downloading") {
      updateBar.textContent = `Downloading update… ${s.percent ?? 0}%`;
      updateBar.hidden = false;
    }
  });
  bridge.onSignedOut((reason) => {
    void teardownCall();
    person = null;
    renderSignIn(reason);
  });

  async function teardownCall() {
    if (!activeCall) return;
    const { handle, session, timer } = activeCall;
    activeCall = null;
    if (timer) clearInterval(timer);
    await handle.leave().catch(() => undefined);
    await bridge.endSession(session.sessionId).catch(() => undefined);
  }

  // ---------- sign in ----------
  function renderSignIn(notice?: string) {
    clear(shell);
    const input = h("input", { id: "code", type: "text", placeholder: "XXXX-XXXX-XXXX", autocomplete: "off", spellcheck: false, maxLength: 300, "aria-label": "Invite code" });
    const server = h("input", { id: "server-address", type: "text", placeholder: "https://… (only if you were given one)", autocomplete: "off", spellcheck: false, "aria-label": "Server address" });
    const error = h("p", { class: "error", role: "alert" }, notice);
    const button = h("button", { class: "primary", type: "submit" }, "Continue");
    const form = h(
      "form",
      {
        class: "card narrow",
        on: {
          submit: async (e) => {
            e.preventDefault();
            if (!input.value.trim()) return;
            button.disabled = true;
            error.textContent = "";
            try {
              const invite = parseInvite(input.value);
              person = await bridge.signIn(invite?.code ?? input.value, invite?.serverUrl ?? (server.value.trim() || undefined));
              await routeAfterSignIn();
            } catch (err) {
              error.textContent = errorText(err);
              button.disabled = false;
            }
          },
        },
      },
      h("h1", {}, "Welcome"),
      h("p", { class: "muted" }, "Enter the invite code you were given to start talking."),
      input,
      h("details", {}, h("summary", {}, "I was given a server address too"), h("div", { class: "field" }, server)),
      button,
      error,
      h("hr"),
      h("p", { class: "muted" }, "Want your own AI self?"),
      h("button", { type: "button", id: "start-setup", on: { click: () => void openWizard() } }, "Set up my own AI self"),
    );
    shell.append(h("main", { class: "center" }, form));
    input.focus();
  }

  async function routeAfterSignIn() {
    if (person?.role === "owner") {
      let onboarding: Awaited<ReturnType<typeof bridge.getOnboarding>> = null;
      try {
        onboarding = await bridge.getOnboarding();
      } catch {
        onboarding = null;
      }
      if (onboarding && !onboarding.state.completedAt && !onboarding.facts.ready) return void openWizard();
    }
    renderHome();
  }

  // ---------- setup guide ----------
  async function openWizard(opts: { free?: boolean; startStep?: StepId } = {}) {
    await teardownCall();
    try {
      await mountWizard(shell, {
        bridge,
        recorders,
        say,
        pollMs: deps.pollMs,
        freeNavigation: opts.free,
        startStep: opts.startStep,
        startTestCall: async () => {
          person = (await bridge.getState()).person;
          await startCall({ returnTo: () => void openWizard({ free: opts.free, startStep: "test" }) });
        },
        onExit: async (connected) => {
          if (connected) {
            person = (await bridge.getState().catch(() => null))?.person ?? person;
            renderHome();
          } else renderSignIn();
        },
        onFinished: async () => {
          const state = await bridge.getState().catch(() => null);
          person = state?.person ?? person;
          say("Your AI self is set up. Share it with the people you invited.", "info");
          renderHome();
        },
      });
    } catch (err) {
      say(errorText(err));
      renderSignIn();
    }
  }

  // ---------- home ----------
  function renderHome() {
    clear(shell);
    if (!person) return renderSignIn();
    const me = person;
    const actions = h(
      "div",
      { class: "row" },
      h("button", { class: "primary big", id: "talk", on: { click: () => void startCall() } }, `Talk to ${me.ownerName}`),
    );
    const card = h(
      "div",
      { class: "card" },
      h("h1", {}, `Hi, ${me.name.split(" ")[0]}`),
      h("p", { class: "muted" }, me.role === "owner" ? "You are signed in as the owner. Try your AI self, or manage it." : `Ready when you are. You'll be talking with an AI version of ${me.ownerName}.`),
      actions,
    );
    if (me.role === "owner") {
      actions.append(h("button", { id: "owner-mode", on: { click: () => renderOwner("overview") } }, "Owner mode"));
      actions.append(h("button", { id: "setup-guide", on: { click: () => void openWizard({ free: true }) } }, "Setup guide"));
    }
    actions.append(
      h("button", { class: "ghost", id: "sign-out", on: { click: async () => { await bridge.signOut(); person = null; renderSignIn(); } } }, "Sign out"),
    );
    shell.append(h("main", { class: "center" }, card));
  }

  // ---------- talk ----------
  async function startCall(opts: { returnTo?: () => void } = {}) {
    if (!person) return;
    const exit = opts.returnTo ?? renderHome;
    const me = person;
    clear(shell);
    const status = h("div", { class: "call-status" }, "Connecting…");
    shell.append(h("main", { class: "center" }, h("div", { class: "card narrow" }, status)));
    let session: SessionInfo;
    try {
      session = await bridge.startSession();
    } catch (err) {
      say(errorText(err));
      return exit();
    }

    const remoteVideo = h("video", { class: "remote", autoplay: true, playsInline: true });
    const remoteAudio = h("audio", { autoplay: true });
    const localVideo = h("video", { class: "local", autoplay: true, muted: true, playsInline: true });
    const placeholder = h("div", { class: "placeholder" }, h("div", { class: "avatar-initials" }, initials(me.ownerName)), h("p", { class: "muted" }, session.mock ? "Mock mode: no live video. Use the text box to talk." : "Connecting to the video…"));
    const timer = h("span", { class: "timer" });
    const log = h("div", { class: "chat-log", "aria-live": "polite" });
    const textInput = h("input", { id: "chat-input", type: "text", placeholder: "Type a message…", maxLength: 2000 });
    const chat = h("form", {
      class: "chat",
      hidden: true,
      on: {
        submit: async (e) => {
          e.preventDefault();
          const text = textInput.value.trim();
          if (!text) return;
          textInput.value = "";
          log.append(h("div", { class: "msg me" }, text));
          try {
            const { reply } = await bridge.sendText(session.sessionId, text);
            log.append(h("div", { class: "msg ai" }, reply));
          } catch (err) {
            log.append(h("div", { class: "msg err" }, errorText(err)));
          }
          log.scrollTop = log.scrollHeight;
        },
      },
    }, log, h("div", { class: "row" }, textInput, h("button", { type: "submit" }, "Send")));

    let muted = false;
    let camOff = false;
    let ended = false;
    const muteBtn = h("button", { id: "mute", "aria-pressed": "false", on: { click: () => { muted = !muted; activeCall?.handle.setMuted(muted); muteBtn.textContent = muted ? "Unmute" : "Mute"; muteBtn.setAttribute("aria-pressed", String(muted)); } } }, "Mute");
    const camBtn = h("button", { id: "camera", "aria-pressed": "false", on: { click: () => { camOff = !camOff; activeCall?.handle.setCameraOff(camOff); camBtn.textContent = camOff ? "Camera on" : "Camera off"; localVideo.hidden = camOff; camBtn.setAttribute("aria-pressed", String(camOff)); } } }, "Camera off");
    const chatBtn = h("button", { id: "chat-toggle", on: { click: () => { chat.hidden = !chat.hidden; if (!chat.hidden) textInput.focus(); } } }, "Text");
    const endBtn = h("button", { class: "danger", id: "end", on: { click: () => finish() } }, "End call");

    let interval: ReturnType<typeof setInterval> | undefined;
    async function finish(message?: string) {
      if (ended) return;
      ended = true;
      if (interval) clearInterval(interval);
      if (activeCall) await teardownCall();
      else await bridge.endSession(session.sessionId).catch(() => undefined);
      if (message) say(message, "info");
      exit();
    }

    clear(shell);
    shell.append(
      h("main", { class: "call" },
        h("div", { class: "stage" },
          remoteVideo, placeholder, remoteAudio,
          session.banner ? h("div", { class: "ai-banner", id: "ai-banner" }, session.banner.text) : null,
          h("div", { class: "pip" }, localVideo),
          h("div", { class: "topbar" }, h("span", {}, `${me.ownerName} (AI)`), timer),
        ),
        chat,
        h("div", { class: "controls" }, muteBtn, camBtn, chatBtn, endBtn),
      ),
    );

    const startedAt = Date.now();
    const tick = () => {
      const left = Math.max(0, session.maxCallSeconds - Math.floor((Date.now() - startedAt) / 1000));
      timer.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`;
      if (left === 0) void finish("The call reached its time limit.");
    };
    tick();
    interval = setInterval(tick, 1000);

    try {
      const handle = await createCall({
        url: session.conversationUrl,
        mock: session.mock,
        elements: { remoteVideo, remoteAudio, localVideo },
        onState: (state, message) => {
          if (state === "live" && !session.mock) placeholder.hidden = true;
          if (state === "ended" && !session.mock) void finish("The call ended.");
          if (state === "error") void finish(message ?? "The call failed.");
        },
      });
      if (ended) {
        await handle.leave().catch(() => undefined);
        return;
      }
      activeCall = { handle, session, timer: interval };
    } catch (err) {
      await finish(`Could not join the call: ${errorText(err)}`);
    }
  }

  // ---------- owner mode ----------
  function renderOwner(tab: OwnerTab) {
    clear(shell);
    const tabs: [OwnerTab, string][] = [["overview", "Overview"], ["upload", "Upload"], ["profile", "Profile"], ["style", "Learned style"], ["people", "People"]];
    const body = h("div", { class: "owner-body" });
    shell.append(
      h("div", { class: "owner" },
        h("header", {}, h("button", { class: "ghost", id: "owner-back", on: { click: renderHome } }, "Back"), h("h2", {}, "Owner mode"),
          h("nav", {}, ...tabs.map(([id, label]) => h("button", { class: id === tab ? "tab active" : "tab", "data-tab": id, on: { click: () => renderOwner(id) } }, label)))),
        body,
      ),
    );
    const views: Record<OwnerTab, (el: HTMLElement) => Promise<void>> = { overview: ownerOverview, upload: ownerUpload, profile: ownerProfile, style: ownerStyle, people: ownerPeople };
    views[tab](body).catch((err) => say(errorText(err)));
  }

  async function ownerOverview(el: HTMLElement) {
    const [vendors, jobsRes] = await Promise.all([bridge.getVendors(true), bridge.listJobs()]);
    const mode = (k: keyof typeof vendors.mode) => h("li", {}, `${k}: `, h("span", { class: `pill ${vendors.mode[k]}` }, vendors.mode[k]));
    const run = (label: string, fn: () => Promise<unknown>, id: string) =>
      h("button", { id, on: { click: async (e) => {
        const b = e.currentTarget as HTMLButtonElement;
        b.disabled = true;
        try {
          const out = (await fn()) as { note?: string } | undefined;
          say(out?.note ?? `${label}: started`, "info");
        } catch (err) {
          say(errorText(err));
        }
        renderOwner("overview");
      } } }, label);
    el.append(
      h("section", { class: "panel" }, h("h3", {}, "Vendors"), h("ul", { class: "plain" }, mode("tavus"), mode("elevenlabs"), mode("deepgram"), mode("llm")),
        vendors.mode.tavus === "mock" || vendors.mode.llm === "mock" ? h("p", { class: "muted" }, "Some vendors are in mock mode (no API key on the server). Calls run, but with placeholder video and replies.") : null),
      h("section", { class: "panel" }, h("h3", {}, "Your clone"),
        h("p", {}, `Voice: ${vendors.voice.status}${vendors.voice.id ? ` (${vendors.voice.id})` : ""}`),
        h("p", {}, `Face replica: ${vendors.replica.status}${vendors.replica.id ? ` (${vendors.replica.id})` : ""}`),
        h("p", {}, `Ready for calls: ${vendors.readyForCalls ? "yes" : "not yet"}`),
        h("div", { class: "row wrap" },
          run("Create/refresh voice", () => bridge.setupVoice(), "setup-voice"),
          run("Start voice training", () => bridge.trainVoice(), "train-voice"),
          run("Create/refresh face", () => bridge.setupReplica(), "setup-replica"),
          run("Link persona", () => bridge.setupPersona(), "setup-persona"))),
      h("section", { class: "panel" }, h("h3", {}, "Training"),
        h("div", { class: "row wrap" },
          run("Refresh persona from uploads", () => bridge.runTraining(false), "run-training"),
          run("Re-process everything", () => bridge.runTraining(true), "run-training-force")),
        h("ul", { class: "plain" }, ...jobsRes.jobs.map((j) => h("li", {}, `${new Date(j.startedAt).toLocaleString()}: ${j.status}, ${j.processedMedia} files, ${j.newFacts} new facts${j.error ? ` (${j.error})` : ""}`)))),
    );
  }

  async function ownerUpload(el: HTMLElement) {
    const list = h("ul", { class: "plain media" });
    const refresh = async () => {
      const { media } = await bridge.listMedia();
      clear(list);
      for (const m of media) {
        list.append(h("li", {},
          h("span", {}, `${m.filename} `), h("span", { class: "muted" }, `${m.kind}, ${PURPOSE_HELP[m.purpose].label}, ${fmtBytes(m.bytes)}`),
          m.error ? h("span", { class: "error" }, ` ${m.error}`) : m.processedAt ? h("span", { class: "pill live" }, "processed") : null,
          h("button", { class: "ghost small", on: { click: async () => { await bridge.deleteMedia(m.id); await refresh(); } } }, "Delete")));
      }
      if (!media.length) list.append(h("li", { class: "muted" }, "Nothing uploaded yet."));
    };
    for (const purpose of ["voice", "replica", "consent", "training"] as MediaPurpose[]) {
      el.append(h("section", { class: "panel" }, h("h3", {}, PURPOSE_HELP[purpose].label), h("p", { class: "muted" }, PURPOSE_HELP[purpose].help),
        h("button", { "data-purpose": purpose, on: { click: async (e) => {
          const b = e.currentTarget as HTMLButtonElement;
          b.disabled = true;
          try {
            const res = await bridge.pickAndUpload(purpose);
            if (res.uploaded.length) say(`Uploaded ${res.uploaded.length} file(s).`, "info");
            if (res.failed.length) say(`${res.failed[0]!.name}: ${res.failed[0]!.message}`);
          } catch (err) { say(errorText(err)); }
          b.disabled = false;
          await refresh();
        } } }, "Choose files…")));
    }
    el.append(h("section", { class: "panel" }, h("h3", {}, "Library"), list));
    await refresh();
  }

  async function ownerProfile(el: HTMLElement) {
    const p = await bridge.getProfile();
    const field = (label: string, control: HTMLElement) => h("label", { class: "field" }, h("span", {}, label), control);
    const name = h("input", { id: "p-name", value: p.displayName });
    const basics = h("textarea", { id: "p-basics", rows: 6, value: p.basics, placeholder: "A short 'about me': who you are, what you do, what you care about." });
    const birthplace = h("input", { id: "p-birth", value: p.birthplace ?? "" });
    const occupation = h("input", { id: "p-occ", value: p.occupation ?? "" });
    const avoid = h("textarea", { id: "p-avoid", rows: 4, value: p.avoidTopics.join("\n"), placeholder: "One topic per line, e.g. my ex" });
    const family = h("textarea", { id: "p-family", rows: 5, value: p.family.map((f) => [f.name, f.relationship, f.notes ?? ""].join(" | ")).join("\n"), placeholder: "Name | relationship | notes (one per line)" });
    const save = h("button", { class: "primary", id: "p-save", on: { click: async () => {
      const profile: Partial<Profile> = {
        displayName: name.value.trim() || p.displayName,
        basics: basics.value,
        birthplace: birthplace.value.trim() || undefined,
        occupation: occupation.value.trim() || undefined,
        avoidTopics: avoid.value.split("\n").map((s) => s.trim()).filter(Boolean),
        family: family.value.split("\n").map((l) => l.split("|").map((s) => s.trim())).filter((c) => c[0] && c[1]).map((c) => ({ name: c[0]!, relationship: c[1]!, notes: c[2] || undefined })),
      };
      try { await bridge.saveProfile(profile); say("Profile saved.", "info"); } catch (err) { say(errorText(err)); }
    } } }, "Save");
    el.append(h("section", { class: "panel form" }, field("Your name", name), field("About you", basics), field("Where you're from", birthplace), field("Work", occupation),
      field("Family and close people", family), field("Never talk about", avoid), save));
  }

  async function ownerStyle(el: HTMLElement) {
    const [{ style }, factsRes] = await Promise.all([bridge.getStyle(), bridge.getFacts()]);
    if (!style) el.append(h("section", { class: "panel" }, h("p", { class: "muted" }, "Nothing learned yet. Upload speech or writing, then refresh the persona on the Overview tab.")));
    else {
      el.append(h("section", { class: "panel" }, h("h3", {}, "How you talk"),
        style.voiceDescription ? h("p", {}, style.voiceDescription) : null,
        h("ul", { class: "plain" },
          h("li", {}, `Learned from ${style.sampleCount} samples (${style.wordCount} words)`),
          h("li", {}, `Average sentence: ${style.avgSentenceWords} words`),
          h("li", {}, `Questions: ${pct(style.questionRate)}, exclamations: ${pct(style.exclamationRate)}, contractions: ${pct(style.contractionRate)}`),
          style.fillers.length ? h("li", {}, `Fillers: ${style.fillers.map((f) => `${f.phrase} (${f.count})`).join(", ")}`) : null,
          style.signaturePhrases.length ? h("li", {}, `Signature phrases: ${style.signaturePhrases.join(", ")}`) : null),
        style.examples.length ? h("details", {}, h("summary", {}, "Example lines"), h("ul", {}, ...style.examples.map((e) => h("li", {}, e)))) : null));
    }
    const factList = h("ul", { class: "plain facts" });
    const renderFact = (f: Fact) => {
      const li = h("li", { "data-status": f.status }, h("span", {}, f.text), " ", h("span", { class: `pill ${f.status}` }, f.status));
      for (const [label, status] of [["Approve", "approved"], ["Reject", "rejected"]] as const) {
        if (f.status !== status) li.append(h("button", { class: "ghost small", on: { click: async () => { const u = await bridge.setFactStatus(f.id, status); li.replaceWith(renderFact(u)); } } }, label));
      }
      return li;
    };
    for (const f of factsRes.facts) factList.append(renderFact(f));
    el.append(h("section", { class: "panel" }, h("h3", {}, "Facts it learned"), h("p", { class: "muted" }, "Only approved facts are used in conversation."), factList.childElementCount ? factList : h("p", { class: "muted" }, "No facts yet.")));
  }

  async function ownerPeople(el: HTMLElement) {
    const list = h("ul", { class: "plain people" });
    const reveal = h("div", { class: "reveal", hidden: true });
    const showCode = (name: string, code: string) => {
      reveal.hidden = false;
      reveal.textContent = `Invite code for ${name}: ${code} (shown once, share it privately)`;
    };
    const refresh = async () => {
      const { people } = await bridge.listPeople();
      clear(list);
      for (const p of people as ManagedPerson[]) {
        const li = h("li", { class: p.revoked ? "revoked" : "" }, h("strong", {}, p.name), h("span", { class: "muted" }, ` ${p.role}${p.relationship && p.relationship !== p.role ? `, ${p.relationship}` : ""}`), p.revoked ? h("span", { class: "pill rejected" }, "revoked") : null);
        if (p.role !== "owner") {
          const banner = h("input", { type: "checkbox", checked: p.aiBanner, on: { change: async (e) => { await bridge.setPersonBanner(p.id, (e.target as HTMLInputElement).checked); } } });
          li.append(h("label", { class: "inline" }, banner, " AI banner"));
          li.append(h("button", { class: "ghost small", on: { click: async () => { const r = await bridge.newInviteCode(p.id); showCode(p.name, r.inviteCode); await refresh(); } } }, "New code"));
          if (p.hasMemory) li.append(h("button", { class: "ghost small", on: { click: async () => { await bridge.clearPersonMemory(p.id); await refresh(); } } }, "Forget conversations"));
          if (!p.revoked) li.append(h("button", { class: "danger small", "data-revoke": p.id, on: { click: async () => { await bridge.revokePerson(p.id); await refresh(); } } }, "Revoke"));
        }
        list.append(li);
      }
    };
    const name = h("input", { id: "new-name", placeholder: "Name" });
    const relationship = h("input", { id: "new-rel", placeholder: "Relationship (mom, college friend…)" });
    const role = h("select", { id: "new-role" }, h("option", { value: "friend" }, "Friend"), h("option", { value: "family" }, "Family"));
    const add = h("button", { class: "primary", id: "add-person", on: { click: async () => {
      if (!name.value.trim()) return;
      try {
        const res = await bridge.addPerson({ name: name.value.trim(), role: role.value as "friend" | "family", relationship: relationship.value.trim() || undefined });
        showCode(res.person.name, res.inviteCode);
        name.value = ""; relationship.value = "";
        await refresh();
      } catch (err) { say(errorText(err)); }
    } } }, "Add person");
    el.append(h("section", { class: "panel" }, h("h3", {}, "Invite someone"), h("div", { class: "row wrap" }, name, relationship, role, add), reveal),
      h("section", { class: "panel" }, h("h3", {}, "People with access"), list));
    await refresh();
  }

  // ---------- boot ----------
  (async () => {
    try {
      const state = await bridge.getState();
      person = state.person;
      if (person) await routeAfterSignIn();
      else {
        let saved: Awaited<ReturnType<typeof bridge.getLocalWizard>> | null = null;
        try {
          saved = await bridge.getLocalWizard();
        } catch {
          saved = null;
        }
        if (saved?.currentStep) void openWizard();
        else renderSignIn();
      }
    } catch {
      renderSignIn();
    }
  })();
}

const initials = (name: string) => name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
