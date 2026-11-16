import type { ServerCheck, VendorName } from "../../shared/bridge.js";
import { normalizeServerUrl } from "../../shared/invite.js";
import { ACCOUNT_GUIDES, DEPLOY_URL } from "../../shared/prompts.js";
import { clear, errorText, h, put, swap } from "../dom.js";
import type { StepRenderer } from "./types.js";
import { busy, callout, copyText, field, section, steps } from "./ui.js";

export const welcomeStep: StepRenderer = (el, ctx) => {
  const consent = ctx.facts().consent;
  const box = h("input", { type: "checkbox", id: "consent-check", checked: consent.accepted });
  const name = h("input", { id: "consent-name", type: "text", value: consent.name, placeholder: "Your full legal name", autocomplete: "name", maxLength: 120 });
  const update = () => ctx.draftConsent({ accepted: box.checked, name: name.value });
  box.addEventListener("change", update);
  name.addEventListener("input", update);

  put(el, 
    section("Make an AI version of yourself",
      h("p", {}, "cloneME builds an AI version of you that your family and friends can video call: it looks like you, sounds like you, and talks the way you talk. This guide walks you through every step. You do not need any technical knowledge, and you can stop and come back at any time."),
      h("p", { class: "muted" }, "Plan on about two hours in total, split across as many sittings as you like."),
    ),
    section("What you will need",
      h("ul", { class: "checks" },
        h("li", {}, "Accounts with four services (Tavus, ElevenLabs, Deepgram and an AI model provider). The next steps link to each one."),
        h("li", {}, "A few dollars of usage plus the monthly plans for Tavus and ElevenLabs, and a small hosting plan for your server."),
        h("li", {}, "A microphone, a webcam, and a quiet, well-lit room."),
        h("li", {}, "About 30 minutes of speaking and 2 minutes of on-camera video."))),
    section("What happens with your data",
      h("ul", { class: "checks" },
        h("li", {}, "Everything is stored on your own server, which only you control. Service keys are kept there and never in this app."),
        h("li", {}, "Your face video goes to Tavus, your voice recordings to ElevenLabs, recordings are transcribed by Deepgram, and your writing and answers are sent to your AI model provider while it replies to people."),
        h("li", {}, "Only people you invite can talk to your AI self. Calls show that it is an AI version of you unless you turn that off for someone."),
        h("li", {}, "You can revoke anyone, make it forget a conversation, or delete recordings whenever you want."))),
    h("section", { class: "panel" },
      h("h3", {}, "Your consent"),
      field("Your full legal name", name, "Tavus requires you to say this name in a short consent video later."),
      h("label", { class: "inline check" }, box, " I understand and agree that my voice, face and writing will be used to create an AI version of me, processed by the services above, and that only I decide who can talk to it.")),
  );
};

export const keysStep: StepRenderer = async (el, ctx) => {
  const intro = section("Create your accounts and paste your keys",
    h("p", {}, "Each service gives you a secret key, like a password for this app. For each card below: create the account, copy the key, paste it here and press Test. The key is checked with a real request. Keys are never shown again and are kept only on your server."),
  );
  const modeNote = h("div", { id: "keys-mode" });
  put(el, intro, modeNote);
  const cards = h("div", { class: "cards" });
  put(el, cards);

  const lastResult = new Map<VendorName, Node[]>();
  const render = async () => {
    const status = await ctx.bridge.getKeysStatus();
    clear(modeNote);
    put(modeNote, 
      status.connected
        ? callout("ok", status.mockMode ? "Your server is in test mode (MOCK_MODE), so keys are saved but not checked with the services." : "Your server is connected. Keys you test here are saved on it.")
        : callout("info", "You have not connected your server yet. Keys are tested right away and held only in this app's memory, then sent to your server the moment you connect it in the next step. If you close the app first, you will need to paste them again."),
    );
    clear(cards);
    for (const guide of ACCOUNT_GUIDES) put(cards, card(guide, status));
    await ctx.refresh();
  };

  function card(guide: (typeof ACCOUNT_GUIDES)[number], status: Awaited<ReturnType<typeof ctx.bridge.getKeysStatus>>) {
    const vendor = guide.id as VendorName;
    const info = status.vendors[vendor];
    const input = h("input", { type: "password", id: `key-${vendor}`, autocomplete: "off", spellcheck: false, placeholder: info.saved || info.staged ? "Key added. Paste a new one to replace it." : "Paste your key here", maxLength: 400 });
    const baseUrl = h("input", { id: "llm-base", type: "text", value: status.llm.baseUrl });
    const model = h("input", { id: "llm-model", type: "text", value: status.llm.model });
    const result = h("div", { class: "key-result", id: `result-${vendor}`, "aria-live": "polite" }, ...(lastResult.get(vendor) ?? []));
    const ok = (info.saved && info.check?.ok !== false) || info.staged;
    const pill = h("span", { class: `pill ${ok ? "live" : "pending"}` }, ok ? (info.saved ? "Saved on your server" : "Tested, held in this app") : "Not added yet");
    const warn = info.warning ? callout("warn", info.warning) : null;
    const test = h("button", { class: "primary", id: `test-${vendor}`, type: "button" }, "Test and save");
    test.addEventListener("click", () =>
      busy(test, ctx.say, async () => {
        const value = input.value.trim();
        if (!value && vendor !== "llm") {
          swap(result, callout("error", "Paste the key first."));
          return;
        }
        const payload = vendor === "llm" ? { llm: { apiKey: value || undefined, baseUrl: baseUrl.value.trim() || undefined, model: model.value.trim() || undefined } } : { [vendor]: value };
        const out = await ctx.bridge.submitKeys(payload);
        const r = out.results[vendor];
        if (!r) {
          swap(result, callout("info", "Settings saved."));
        } else if (r.ok) {
          input.value = "";
          lastResult.set(vendor, [callout("ok", r.message)]);
          await render();
        } else {
          swap(result, callout("error", r.message));
        }
      }, errorText),
    );
    return h("section", { class: "panel key-card", "data-vendor": vendor },
      h("div", { class: "row between" }, h("h3", {}, guide.name), pill),
      h("p", {}, guide.purpose),
      h("div", { class: "row wrap" },
        h("button", { type: "button", "data-open": `${vendor}-signup`, on: { click: () => void ctx.bridge.openExternal(guide.signupUrl).catch((e) => ctx.say(errorText(e))) } }, `Create ${guide.name} account`),
        h("button", { type: "button", "data-open": `${vendor}-keys`, on: { click: () => void ctx.bridge.openExternal(guide.keyUrl).catch((e) => ctx.say(errorText(e))) } }, "Open the key page")),
      steps(guide.steps),
      h("p", { class: "muted" }, guide.cost),
      guide.note ? h("p", { class: "muted" }, guide.note) : null,
      field("Secret key", input),
      vendor === "llm" ? h("details", {}, h("summary", {}, "Using a different provider?"), field("API address", baseUrl), field("Model name", model)) : null,
      h("div", { class: "row" }, test),
      warn,
      result,
    );
  }

  await render();
  if ((await ctx.bridge.getKeysStatus()).connected) {
    const recheck = h("button", { id: "recheck-keys", type: "button" }, "Re-test all saved keys");
    recheck.addEventListener("click", () =>
      busy(recheck, ctx.say, async () => {
        const { results } = await ctx.bridge.recheckKeys();
        const bad = Object.entries(results).filter(([, r]) => !r.ok);
        ctx.say(bad.length ? `${bad.map(([v, r]) => `${v}: ${r.message}`)[0]}` : "All saved keys work.", bad.length ? "error" : "info");
        await render();
      }, errorText),
    );
    put(el, h("div", { class: "row" }, recheck));
  }
};

const checkRows = (c: ServerCheck) => [
  { ok: c.reachable && c.isCloneme, label: c.reachable && c.isCloneme ? "Your server is online" : c.message },
  { ok: c.https, label: c.https ? "It has a secure address (https)" : "It needs a secure https:// address" },
  { ok: c.persistentStorage, label: c.persistentStorage ? "It saves your data permanently" : "It does not report permanent storage (data could be lost on restart)" },
  { ok: c.claimed || c.claimable, label: c.claimed ? "It already has an owner" : c.claimable ? "It is ready to be claimed by you" : "It was not set up with a setup token" },
];

export const serverStep: StepRenderer = async (el, ctx) => {
  const connected = ctx.data() !== null;
  const existingUrl = ctx.serverUrl();
  const url = h("input", { id: "server-url", type: "text", value: existingUrl, placeholder: "https://your-name.onrender.com", spellcheck: false, autocomplete: "off" });
  const token = h("input", { id: "setup-token", type: "password", placeholder: "Paste SETUP_TOKEN here", autocomplete: "off", spellcheck: false });
  const ownerCode = h("input", { id: "owner-code", type: "text", placeholder: "XXXX-XXXX-XXXX", autocomplete: "off", spellcheck: false });
  const results = h("div", { id: "server-checks" });
  const connectResult = h("div", { id: "connect-result", "aria-live": "polite" });
  let mode: "new" | "existing" = "new";

  const showChecks = (c: ServerCheck) => {
    clear(results);
    put(results, 
      h("ul", { class: "plain checklist" }, ...checkRows(c).map((r) => h("li", { class: r.ok ? "ok" : "bad" }, h("span", { class: "mark" }, r.ok ? "\u2713" : "\u2717"), r.label))),
      c.reachable && c.isCloneme && !c.https ? null : null,
    );
  };

  const check = h("button", { id: "check-server", type: "button" }, "Check my server");
  check.addEventListener("click", () =>
    busy(check, ctx.say, async () => {
      const address = normalizeServerUrl(url.value);
      if (!address) {
        swap(results, callout("error", "That address does not look right. It should look like https://your-name.onrender.com"));
        return;
      }
      url.value = address;
      const c = await ctx.bridge.checkServer(address);
      showChecks(c);
      ctx.setServerCheck(c, address);
    }, errorText),
  );

  const connect = h("button", { class: "primary", id: "connect-server", type: "button" }, "Connect to my server");
  connect.addEventListener("click", () =>
    busy(connect, ctx.say, async () => {
      const address = normalizeServerUrl(url.value);
      if (!address) {
        swap(connectResult, callout("error", "Enter your server address first."));
        return;
      }
      try {
        const out = await ctx.bridge.connectServer({
          serverUrl: address,
          ...(mode === "new" ? { setupToken: token.value.trim(), ownerName: ctx.facts().consent.name || undefined } : { ownerCode: ownerCode.value.trim() }),
        });
        token.value = "";
        ownerCode.value = "";
        const flushed = Object.keys(out.keyResults).length;
        const failedKeys = Object.entries(out.keyResults).filter(([, r]) => !r.ok);
        swap(connectResult, 
          callout("ok", `Connected as ${out.person.name}.${flushed ? ` Your ${flushed} tested key${flushed === 1 ? "" : "s"} moved to your server.` : ""}`),
          failedKeys.length ? callout("error", `The server rejected the ${failedKeys.map(([v]) => v).join(", ")} key. Go back to step 2 and test it again.`) : null,
          out.ownerCode ? ownerCodeBox(out.ownerCode) : null,
        );
        const c = await ctx.bridge.checkServer(address);
        showChecks(c);
        ctx.setServerCheck(c, address);
        await ctx.refresh();
      } catch (err) {
        swap(connectResult, callout("error", errorText(err)));
      }
    }, errorText),
  );

  const ownerCodeBox = (code: string) => {
    const field = h("input", { id: "owner-code-out", readOnly: true, value: code, "aria-label": "Your owner code" });
    return h("div", { class: "callout warn", id: "owner-code-box" },
      h("strong", {}, "Save your owner code now"),
      h("p", {}, "This code signs you in as the owner on another computer or after reinstalling. It is shown only once. Save it in a password manager or write it down."),
      h("div", { class: "row" }, field, h("button", { type: "button", on: { click: async () => ctx.say((await copyText(code, field)) ? "Copied." : "Select the code and copy it.", "info") } }, "Copy")));
  };

  const modeToggle = h("button", { class: "link", id: "server-mode", type: "button" }, "I already set up my server before");
  const newBox = h("div", { id: "claim-new" }, field("Setup token", token, "In Render, open your service, then Environment, and copy the value of SETUP_TOKEN."));
  const existingBox = h("div", { id: "claim-existing", hidden: true }, field("Owner code", ownerCode, "The code you saved when you first connected this server."));
  modeToggle.addEventListener("click", () => {
    mode = mode === "new" ? "existing" : "new";
    newBox.hidden = mode !== "new";
    existingBox.hidden = mode !== "existing";
    modeToggle.textContent = mode === "new" ? "I already set up my server before" : "This is a brand new server";
  });

  if (connected) {
    put(el, 
      section("Your server is connected",
        callout("ok", `Connected to ${existingUrl || "your server"}.`),
        h("div", { class: "row" }, check), results),
    );
    if (existingUrl) {
      const c = await ctx.bridge.checkServer(existingUrl);
      showChecks(c);
      ctx.setServerCheck(c, existingUrl);
    }
    return;
  }

  put(el, 
    section("Why you need a server",
      h("p", {}, "Your AI self needs a small always-on program on the internet. It holds your keys safely, remembers your conversations, and answers when a friend calls. We use Render, which sets this up with one click and a few minutes of waiting."),
      h("p", { class: "muted" }, "Cost: Render's Starter plan (about $7 a month) plus a 10 GB storage disk (about $2.50 a month); check Render for current prices. You can cancel in Render at any time.")),
    section("1. Create your server",
      steps([
        "Press the button below. Render opens in your browser; create a free Render account if asked.",
        "Render shows the cloneME setup. Leave the settings as they are, choose the Starter plan, and press Deploy.",
        "Wait until Render says the service is live (usually 3 to 5 minutes).",
        "Copy the address at the top of the service page. It looks like https://cloneme-xxxx.onrender.com",
      ]),
      h("div", { class: "row" }, h("button", { class: "primary", id: "deploy-render", type: "button", on: { click: () => void ctx.bridge.openExternal(DEPLOY_URL).catch((e) => ctx.say(errorText(e))) } }, "Create my server on Render"))),
    section("2. Tell the app where it is",
      field("Server address", url),
      h("div", { class: "row" }, check),
      results),
    section("3. Claim it as yours",
      h("p", {}, "So that nobody else can take over your new server, Render created a secret setup token just for you."),
      newBox, existingBox,
      h("div", { class: "row between" }, connect, modeToggle),
      connectResult),
  );
};
