/**
 * Development/demo launcher: `electron scripts/demo-main.cjs`. Answers the vendor key checks locally so the onboarding
 * wizard can be shown without real accounts (a key starting with "bad" is rejected). Never used in the packaged app.
 */
const realFetch = globalThis.fetch;
const VENDOR_HOSTS = /^https:\/\/(tavusapi\.com|api\.elevenlabs\.io|api\.deepgram\.com|api\.openai\.com)\//;

globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!VENDOR_HOSTS.test(url)) return realFetch(input, init);
  const headers = new Headers(init && init.headers);
  const key = headers.get("x-api-key") || headers.get("xi-api-key") || (headers.get("authorization") || "").replace(/^(Bearer|Token) /, "");
  if (!key || key.startsWith("bad")) return new Response("{}", { status: 401 });
  const body = url.includes("elevenlabs") ? { can_use_professional_voice_cloning: !key.includes("basic") } : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

require("../dist/main.cjs");
