import type { FamilyMember, MediaItem } from "../../shared/bridge.js";
import { shareMessage } from "../../shared/invite.js";
import { AVOID_SUGGESTIONS, composeBasics, QUESTIONNAIRE } from "../../shared/prompts.js";
import { clear, errorText, h, put, swap } from "../dom.js";
import type { StepRenderer } from "./types.js";
import { busy, callout, copyText, field, section } from "./ui.js";

const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

export const uploadsStep: StepRenderer = async (el, ctx) => {
  const list = h("ul", { class: "plain media", id: "upload-list" });
  const refresh = async () => {
    const { media } = await ctx.bridge.listMedia();
    const extras = media.filter((m: MediaItem) => m.purpose === "training" || (m.purpose === "voice" && !m.promptId));
    clear(list);
    for (const m of extras) {
      put(list, h("li", {},
        h("span", {}, `${m.filename} `), h("span", { class: "muted" }, `${m.kind}, ${fmtBytes(m.bytes)}${m.purpose === "voice" ? ", counts toward your voice total" : ""}`),
        h("button", { class: "ghost small", type: "button", on: { click: async () => { await ctx.bridge.deleteMedia(m.id); await refresh(); await ctx.refresh(); } } }, "Remove")));
    }
    if (!extras.length) put(list, h("li", { class: "muted" }, "Nothing added yet. This step is optional."));
  };
  const add = (id: string, label: string, run: () => Promise<{ uploaded: unknown[]; failed: { name: string; message: string }[] }>) => {
    const b = h("button", { id, type: "button" }, label);
    b.addEventListener("click", () =>
      busy(b, ctx.say, async () => {
        const res = await run();
        if (res.uploaded.length) ctx.say(`Added ${res.uploaded.length} file${res.uploaded.length === 1 ? "" : "s"}.`, "info");
        if (res.failed.length) ctx.say(`${res.failed[0]!.name}: ${res.failed[0]!.message}`);
        await refresh();
        await ctx.refresh();
      }, errorText),
    );
    return b;
  };
  put(el, 
    section("Anything else that sounds like you? (optional)",
      h("p", {}, "The more of your real voice and writing the AI sees, the more it sounds like you. Skip this if you like; you can add more at any time from the owner area."),
      h("ul", { class: "checks" },
        h("li", {}, h("strong", {}, "Existing recordings: "), "voice memos, podcasts or calls with only you speaking. They are transcribed to learn how you talk and also count toward your voice total."),
        h("li", {}, h("strong", {}, "Videos and photos: "), "family videos help it learn your expressions and stories."),
        h("li", {}, h("strong", {}, "Texts and writing: "), "exported chats, emails or notes (.txt) teach your phrasing.")),
      h("div", { class: "row wrap" },
        add("upload-voice", "Add voice recordings…", () => ctx.bridge.uploadExistingVoice()),
        add("upload-other", "Add videos, photos or texts…", () => ctx.bridge.pickAndUpload("training"))),
    ),
    section("What you added", list),
  );
  await refresh();
};

export const aboutStep: StepRenderer = (el, ctx) => {
  const profile = ctx.data()?.facts.profile;
  const answers: Record<string, string> = { ...(profile?.answers ?? {}) };
  let family: FamilyMember[] = [...(profile?.family ?? [])];
  const status = h("small", { class: "muted", id: "about-status", "aria-live": "polite" }, "Saved automatically as you type.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;

  const displayName = () => profile?.displayName || ctx.facts().consent.name || ctx.ownerName();

  async function save() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!dirty) return;
    dirty = false;
    status.textContent = "Saving…";
    try {
      const cleaned = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
      await ctx.bridge.saveProfile({
        answers: cleaned,
        basics: composeBasics(displayName(), cleaned),
        birthplace: cleaned.hometown || undefined,
        occupation: cleaned.work || undefined,
        family,
      });
      status.textContent = "Saved.";
      await ctx.refresh();
    } catch (err) {
      dirty = true;
      status.textContent = errorText(err);
    }
  }
  const queue = () => {
    dirty = true;
    status.textContent = "Typing…";
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void save(), 700);
  };
  ctx.onCleanup(() => void save());

  const questions = QUESTIONNAIRE.map((q) => {
    const area = h("textarea", { id: `q-${q.id}`, rows: q.rows ?? 2, maxLength: 500, value: answers[q.id] ?? "", placeholder: q.hint });
    area.addEventListener("input", () => {
      answers[q.id] = area.value;
      queue();
    });
    area.addEventListener("blur", () => void save());
    return field(`${q.label}${q.required ? " *" : ""}`, area);
  });

  const familyList = h("ul", { class: "plain", id: "family-list" });
  const renderFamily = () => {
    clear(familyList);
    for (const [i, f] of family.entries()) {
      put(familyList, h("li", { class: "row between" },
        h("span", {}, h("strong", {}, f.name), ` (${f.relationship})`, f.notes ? h("span", { class: "muted" }, ` ${f.notes}`) : null),
        h("button", { class: "ghost small", type: "button", on: { click: () => { family = family.filter((_, j) => j !== i); renderFamily(); dirty = true; void save(); } } }, "Remove")));
    }
    if (!family.length) put(familyList, h("li", { class: "muted" }, "No one added yet."));
  };
  const fName = h("input", { id: "fam-name", placeholder: "Name", maxLength: 80 });
  const fRel = h("input", { id: "fam-rel", placeholder: "Relationship (mom, best friend…)", maxLength: 60 });
  const fNotes = h("input", { id: "fam-notes", placeholder: "Something it should know (optional)", maxLength: 500 });
  const addFam = h("button", { id: "fam-add", type: "button" }, "Add");
  addFam.addEventListener("click", () => {
    if (!fName.value.trim() || !fRel.value.trim()) {
      ctx.say("Enter a name and how they are related to you.");
      return;
    }
    family.push({ name: fName.value.trim(), relationship: fRel.value.trim(), notes: fNotes.value.trim() || undefined });
    fName.value = fRel.value = fNotes.value = "";
    renderFamily();
    dirty = true;
    void save();
  });
  renderFamily();

  put(el, 
    section("Tell it about yourself",
      h("p", {}, "Answer in your own words, as you would tell a new friend. Short answers are fine. Questions marked * are required. The AI uses this to stay true to who you are."),
      ...questions, status),
    section("Family and friends it should know",
      h("p", { class: "muted" }, "Names, how they are related to you, and anything worth knowing, like \"my sister, lives in Denver, has two kids\"."),
      familyList,
      h("div", { class: "row wrap" }, fName, fRel, fNotes, addFam)),
  );
};

export const avoidStep: StepRenderer = (el, ctx) => {
  let topics = [...(ctx.data()?.facts.profile.avoidTopics ?? [])];
  let none = Boolean(ctx.data()?.state.avoidNone);
  const chips = h("div", { class: "chips", id: "avoid-chips" });
  const custom = h("input", { id: "avoid-custom", placeholder: "Add your own topic", maxLength: 120 });
  const noneBox = h("input", { type: "checkbox", id: "avoid-none", checked: none });

  async function persist() {
    try {
      await ctx.bridge.saveProfile({ avoidTopics: topics });
      await ctx.bridge.saveOnboarding({ avoidNone: none });
      await ctx.refresh();
    } catch (err) {
      ctx.say(errorText(err));
    }
  }
  const toggle = (t: string) => {
    topics = topics.includes(t) ? topics.filter((x) => x !== t) : [...topics, t];
    if (topics.length) none = false;
    noneBox.checked = none;
    render();
    void persist();
  };
  function render() {
    clear(chips);
    const all = [...AVOID_SUGGESTIONS, ...topics.filter((t) => !AVOID_SUGGESTIONS.includes(t))];
    for (const t of all) put(chips, h("button", { type: "button", class: `chip${topics.includes(t) ? " on" : ""}`, "aria-pressed": String(topics.includes(t)), "data-topic": t, on: { click: () => toggle(t) } }, t));
  }
  render();
  noneBox.addEventListener("change", () => {
    none = noneBox.checked;
    if (none) {
      topics = [];
      render();
    }
    void persist();
  });
  const add = () => {
    const t = custom.value.trim();
    if (!t) return;
    custom.value = "";
    if (!topics.includes(t)) toggle(t);
  };
  custom.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      add();
    }
  });

  put(el, 
    section("Topics your AI self should never discuss",
      h("p", {}, "If someone brings one of these up, it will politely change the subject. Pick any that apply, or add your own."),
      chips,
      h("div", { class: "row" }, custom, h("button", { id: "avoid-add", type: "button", on: { click: add } }, "Add")),
      h("label", { class: "inline check" }, noneBox, " There is nothing I need it to avoid.")),
  );
};

export const inviteStep: StepRenderer = async (el, ctx) => {
  const list = h("ul", { class: "plain people", id: "invite-list" });
  const reveal = h("div", { id: "invite-reveal" });
  const name = h("input", { id: "invite-name", placeholder: "Their name", maxLength: 80 });
  const rel = h("input", { id: "invite-rel", placeholder: "Relationship (mom, college friend…)", maxLength: 60 });
  const role = h("select", { id: "invite-role" }, h("option", { value: "friend" }, "Friend (sees an AI banner)"), h("option", { value: "family" }, "Family"));
  const later = h("input", { type: "checkbox", id: "invite-later", checked: Boolean(ctx.data()?.state.skipped.invite) });

  const showCode = (person: string, code: string) => {
    const data = ctx.data();
    const msg = shareMessage({ friendName: person, ownerName: ctx.ownerName() || ctx.facts().consent.name, installerUrl: data?.installerUrl ?? "", serverUrl: data?.serverUrl || ctx.serverUrl(), code });
    const box = h("textarea", { id: "invite-message", rows: 9, readOnly: true, value: msg });
    clear(reveal);
    put(reveal, h("div", { class: "callout ok" },
      h("strong", {}, `Invite for ${person}`),
      h("p", {}, "Their code is shown only now. Copy the message and send it to them privately (text or email)."),
      h("p", { class: "code", id: "invite-code" }, code),
      box,
      h("div", { class: "row" }, h("button", { id: "invite-copy", type: "button", class: "primary", on: { click: async () => ctx.say((await copyText(msg, box)) ? "Message copied." : "Select the message and copy it.", "info") } }, "Copy message"))));
  };

  const refreshList = async () => {
    const { people } = await ctx.bridge.listPeople();
    clear(list);
    for (const p of people.filter((x) => x.role !== "owner" && !x.revoked)) {
      put(list, h("li", { class: "row between" },
        h("span", {}, h("strong", {}, p.name), h("span", { class: "muted" }, ` ${p.relationship}`)),
        h("button", { class: "ghost small", type: "button", on: { click: async () => { const r = await ctx.bridge.newInviteCode(p.id); showCode(p.name, r.inviteCode); } } }, "New code and message")));
    }
    if (!list.childElementCount) put(list, h("li", { class: "muted" }, "No one invited yet."));
  };

  const create = h("button", { class: "primary", id: "invite-create", type: "button" }, "Create invite");
  create.addEventListener("click", () =>
    busy(create, ctx.say, async () => {
      if (!name.value.trim()) {
        ctx.say("Enter their name.");
        return;
      }
      const res = await ctx.bridge.addPerson({ name: name.value.trim(), role: role.value as "friend" | "family", relationship: rel.value.trim() || undefined });
      showCode(res.person.name, res.inviteCode);
      name.value = rel.value = "";
      later.checked = false;
      await refreshList();
      await ctx.refresh();
    }, errorText),
  );
  later.addEventListener("change", async () => {
    try {
      await ctx.bridge.saveOnboarding({ skipped: { invite: later.checked } });
      await ctx.refresh();
    } catch (err) {
      ctx.say(errorText(err));
    }
  });

  put(el, 
    section("Who may talk to your AI self?",
      h("p", {}, "Only people you invite can call it. Each person gets their own private code, so you can remove one person without affecting the others. Their conversations are kept separate."),
      h("div", { class: "row wrap" }, name, rel, role, create),
      reveal),
    section("People you invited", list,
      callout("info", "You can invite more people at any time from owner mode."),
      h("label", { class: "inline check" }, later, " I will invite people later.")),
  );
  await refreshList();
};
