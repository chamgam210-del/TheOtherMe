/**
 * Drives the real Electron app (started with --remote-debugging-port) through every onboarding step and saves a
 * screenshot of each one. Usage: node scripts/capture-onboarding.mjs <outDir> [port] [serverUrl] [setupToken]
 *
 * Real recordings use Chromium's fake camera and microphone. To keep the run short, most of the 30 minutes of voice
 * clips are generated tone-and-pause WAV files uploaded through the same bridge call the recorder uses.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [outDir, port = "9222", serverUrl = "http://127.0.0.1:8787", setupToken = "demo-setup-token-1234"] = process.argv.slice(2);
if (!outDir) throw new Error("usage: capture-onboarding.mjs <outDir> [port] [serverUrl] [setupToken]");
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d);
    pending.delete(d.id);
  }
};
const send = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluate failed");
  return r.result.result.value;
};
const q = (sel) => JSON.stringify(sel);
const waitFor = async (expr, label, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await js(`Boolean(${expr})`)) return;
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${label ?? expr}`);
};
const exists = (sel) => `document.querySelector(${q(sel)})`;
const click = async (sel) => {
  await waitFor(exists(sel), sel);
  await js(`document.querySelector(${q(sel)}).click()`);
  await sleep(250);
};
const type = async (sel, value) => {
  await waitFor(exists(sel), sel);
  await js(`(() => { const e = document.querySelector(${q(sel)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await sleep(150);
};
const tick = async (sel) => {
  await js(`(() => { const e = document.querySelector(${q(sel)}); e.checked = true; e.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await sleep(200);
};
const enabled = (sel) => `${exists(sel)} && !document.querySelector(${q(sel)}).disabled`;
const shots = [];
const shot = async (name, { scrollTo } = {}) => {
  if (scrollTo) await js(`document.querySelector(${q(scrollTo)})?.scrollIntoView({block:'center'})`);
  await sleep(350);
  const r = await send("Page.captureScreenshot", { format: "png" });
  const file = path.join(outDir, `${name}.png`);
  writeFileSync(file, Buffer.from(r.result.data, "base64"));
  shots.push(file);
  console.log("shot", file);
};
const step = () => js(`document.querySelector('.step-link.current')?.dataset.step`);
const next = async () => {
  await waitFor(enabled("#wizard-next"), "Next enabled");
  await click("#wizard-next");
  await sleep(500);
};

await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.enable");
await waitFor(exists("#start-setup"), "sign-in screen");
await shot("00-sign-in");

// 1 welcome
await click("#start-setup");
await waitFor(exists("#consent-name"));
await shot("01-welcome-consent-empty");
await type("#consent-name", "Sam Rivera");
await tick("#consent-check");
await shot("01-welcome-consent-done");
await next();

// 2 keys
await waitFor(exists(".key-card"));
await shot("02-keys-start");
await type("#key-tavus", "bad-key-1234567890");
await click("#test-tavus");
await waitFor(`${exists("#result-tavus .callout")}`);
await shot("02-keys-rejected-key", { scrollTo: "#result-tavus" });
await type("#key-tavus", "tvs_demo_valid_key_1234567890");
await click("#test-tavus");
await type("#key-elevenlabs", "el_demo_basic_plan_key_1234567890");
await click("#test-elevenlabs");
await type("#key-deepgram", "dg_demo_valid_key_1234567890");
await click("#test-deepgram");
await type("#key-llm", "sk_demo_valid_key_1234567890");
await click("#test-llm");
await waitFor(`document.querySelectorAll('.key-card .pill.live').length === 4`, "all four keys tested");
await shot("02-keys-all-tested-top");
await shot("02-keys-pvc-warning", { scrollTo: "#result-elevenlabs" });
await next();

// 3 server
await waitFor(exists("#server-url"));
await shot("03-server-start");
await type("#server-url", "http://127.0.0.1:9");
await click("#check-server");
await waitFor(`${exists("#server-checks li")}`);
await shot("03-server-unreachable", { scrollTo: "#server-checks" });
await type("#server-url", serverUrl);
await click("#check-server");
await waitFor(`document.querySelector('#server-checks')?.textContent.includes('online')`);
await type("#setup-token", "wrong-token-for-demo-1");
await click("#connect-server");
await waitFor(`document.querySelector('#connect-result')?.textContent.includes('not right')`);
await shot("03-server-wrong-token", { scrollTo: "#connect-result" });
await type("#setup-token", setupToken);
await click("#connect-server");
await waitFor(exists("#owner-code-box"), "owner code");
await shot("03-server-connected-owner-code", { scrollTo: "#owner-code-box" });
await next();

// 4 voice: one real in-app recording, the rest generated
await waitFor(exists("#voice-record"));
await shot("04-voice-start");
// First take uses Chromium's fake microphone (a loud beep in silence), which the clip check rightly rejects.
await click("#voice-record");
await sleep(22000);
await click("#voice-stop");
await waitFor(exists("#voice-stats"));
await shot("04-voice-clip-check-rejected", { scrollTo: "#voice-stats" });

// Second take: the same recorder code, but the microphone is replaced by a synthesized speech-like signal.
await js(`(() => {
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    if (!(c && c.audio && !c.video)) return orig(c);
    const ctx = new AudioContext();
    await ctx.resume();
    const dest = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    for (const [mult, amp] of [[1, 0.5], [2, 0.3], [3, 0.2], [4, 0.1]]) {
      const o = ctx.createOscillator();
      o.frequency.value = 130 * mult;
      const g = ctx.createGain();
      g.gain.value = amp;
      o.connect(g).connect(gain);
      o.start();
    }
    gain.connect(dest);
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * 0.0015;
    const ns = ctx.createBufferSource();
    ns.buffer = noise;
    ns.loop = true;
    ns.connect(dest);
    ns.start();
    let t = ctx.currentTime;
    for (let i = 0; i < 400; i++) {
      const len = 0.18 + Math.random() * 0.2;
      gain.gain.setTargetAtTime(0.16 + Math.random() * 0.12, t, 0.02);
      t += len;
      gain.gain.setTargetAtTime(0, t, 0.02);
      t += 0.08 + Math.random() * 0.12;
    }
    return dest.stream;
  };
})()`);
await click('[data-step="keys"]');
await click('[data-step="voice"]');
await waitFor(exists("#voice-record"));
await click("#voice-record");
await sleep(8000);
await shot("04-voice-recording");
await sleep(16000);
await click("#voice-stop");
await waitFor(exists("#voice-stats"));
await shot("04-voice-clip-check-ok", { scrollTo: "#voice-stats" });
const keepEnabled = await js(enabled("#voice-keep"));
if (keepEnabled) await click("#voice-keep");
await js(`(async () => {
  const sr = 16000;
  const wav = (seconds) => {
    const n = sr * seconds, pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const talking = Math.floor(i / (sr * 0.45)) % 4 !== 3;
      const t = i / sr, f = 140 + 40 * Math.sin(t * 0.7);
      const v = talking ? 0.22 * (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t)) : 0;
      pcm[i] = Math.max(-1, Math.min(1, v + 0.0006 * Math.sin(i * 12.9898))) * 32767;
    }
    const buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
    const w = (o, s) => [...s].forEach((c, k) => dv.setUint8(o + k, c.charCodeAt(0)));
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
    new Int16Array(buf, 44).set(pcm);
    return new Uint8Array(buf);
  };
  const have = new Set([...document.querySelectorAll('.prompt-item.done')].map((b) => b.dataset.prompt));
  const items = [...document.querySelectorAll('.prompt-item')].map((b) => b.dataset.prompt).filter((id) => !have.has(id));
  let seconds = 0;
  for (const id of items) {
    if (seconds >= 1860) break;
    const kind = id.startsWith('read') ? 'reading' : 'story';
    const dur = kind === 'reading' ? 90 : 120;
    await window.cloneme.uploadRecording({ purpose: 'voice', filename: id + '.wav', mimeType: 'audio/wav', data: wav(dur), durationSec: dur, promptId: id, promptKind: kind });
    seconds += dur;
  }
})()`);
await click('[data-step="keys"]');
await click('[data-step="voice"]');
await waitFor(`document.querySelectorAll('.prompt-item.done').length >= 12`);
await shot("04-voice-30-minutes-done");
await next();

// 5 training video: real 95 s recording
await waitFor(enabled("#video-record"), "camera ready");
await sleep(2500);
await shot("05-video-framing-and-lighting");
await click("#video-record");
await sleep(30000);
await shot("05-video-recording");
await sleep(65000);
await click("#video-stop");
await waitFor(exists("#video-playback"));
await sleep(1500);
await shot("05-video-playback-retake");
await click("#video-use");
await waitFor(`document.querySelector('#replica-stage .callout')?.textContent.includes('Saved')`);
await shot("05-video-saved");
await next();

// 6 consent video: real recording
await waitFor(enabled("#video-record"), "camera ready");
await sleep(2000);
await shot("06-consent-statement");
await click("#video-record");
await sleep(6000);
await shot("06-consent-recording");
await sleep(5000);
await click("#video-stop");
await waitFor(exists("#video-use"));
await click("#video-use");
await waitFor(`document.querySelector('#consent-stage .callout')?.textContent.includes('Saved')`);
await next();

// 7 uploads (optional)
await waitFor(exists("#upload-voice"));
await shot("07-optional-uploads");
await next();

// 8 about me
await waitFor(exists("#q-hometown"));
await type("#q-nickname", "Sammy");
await type("#q-hometown", "Portland, Oregon, then Seattle for college");
await type("#q-work", "Product designer at a small climate startup");
await type("#q-personality", "Warm, a bit wry, easily distracted by good snacks");
await type("#q-humor", "Dry one-liners and terrible puns");
await type("#q-hobbies", "Trail running, pottery, and board games on Sundays");
await type("#fam-name", "Dana");
await type("#fam-rel", "younger sister");
await type("#fam-notes", "Lives in Denver, two kids, calls me Sammy-bear");
await click("#fam-add");
await sleep(1200);
await shot("08-about-me-top");
await shot("08-about-me-family", { scrollTo: "#family-list" });
await next();

// 9 avoid
await waitFor(exists("#avoid-chips"));
await click('[data-topic="politics"]');
await click('[data-topic="my ex"]');
await type("#avoid-custom", "my brother's divorce");
await click("#avoid-add");
await shot("09-topics-to-avoid");
await next();

// 10 invite
await waitFor(exists("#invite-name"));
await type("#invite-name", "Alex Kim");
await type("#invite-rel", "college roommate");
await click("#invite-create");
await waitFor(exists("#invite-message"));
await shot("10-invite-share-message", { scrollTo: "#invite-message" });
await next();

// 11 build
await waitFor(exists("#build-start"));
await shot("11-build-ready-to-start");
await click("#build-start");
await sleep(600);
await shot("11-build-running");
await waitFor(exists("#manual-action"), "verification step", 60000);
await shot("11-build-elevenlabs-verification", { scrollTo: "#manual-action" });
await click("#manual-done");
await waitFor(enabled("#wizard-next"), "build ready", 90000);
await shot("11-build-finished");
await next();

// 12 test call
await waitFor(exists("#test-call"));
await shot("12-test-call-ready");
await click("#test-call");
await waitFor(exists(".call"), "call screen");
await sleep(800);
await click("#chat-toggle");
await type("#chat-input", "Hey, it's me. Tell me something only I would know.");
await js(`document.querySelector('.chat').dispatchEvent(new Event('submit', {cancelable:true}))`);
await waitFor(`document.querySelectorAll('.msg.ai').length >= 1`, "AI reply");
await shot("12-test-call-in-progress");
await click("#end");
await waitFor(exists("#wizard"), "wizard after call");
await waitFor(enabled("#wizard-next"), "finish enabled");
await shot("12-test-call-done-finish");
await click("#wizard-next");
await waitFor(exists("#setup-guide"), "home after finish");
await shot("13-finished-home");

// owner can reopen any step
await click("#setup-guide");
await waitFor(exists("#wizard"));
await click('[data-step="about"]');
await waitFor(exists("#q-hometown"));
await shot("14-owner-reopens-any-step");

writeFileSync(path.join(outDir, "index.txt"), shots.map((s) => path.basename(s)).join("\n") + "\n");
console.log(`done: ${shots.length} screenshots`);
ws.close();
