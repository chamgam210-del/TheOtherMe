export interface ParsedInvite {
  code: string;
  serverUrl?: string;
}

const CODE = /([A-Za-z0-9]{4}[-\s]?[A-Za-z0-9]{4}[-\s]?[A-Za-z0-9]{4})/;

export function normalizeServerUrl(input: string): string | null {
  let value = input.trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.protocol}//${url.host}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Accepts a bare code, a `cloneme://join?server=...&code=...` link, or "https://server CODE". */
export function parseInvite(input: string): ParsedInvite | null {
  const text = input.trim();
  if (!text) return null;
  const link = /cloneme:\/\/join\?(\S+)/i.exec(text);
  if (link) {
    const params = new URLSearchParams(link[1]);
    const code = params.get("code");
    const server = normalizeServerUrl(params.get("server") ?? "");
    return code ? { code: code.toUpperCase(), serverUrl: server ?? undefined } : null;
  }
  const url = /https?:\/\/\S+/i.exec(text);
  const rest = url ? text.replace(url[0], " ") : text;
  const code = CODE.exec(rest)?.[1];
  if (!code) return null;
  return { code: code.replace(/\s+/g, "-").toUpperCase(), serverUrl: url ? (normalizeServerUrl(url[0]) ?? undefined) : undefined };
}

export const joinLink = (serverUrl: string, code: string) => `cloneme://join?server=${encodeURIComponent(serverUrl)}&code=${encodeURIComponent(code)}`;

export function shareMessage(opts: { friendName: string; ownerName: string; installerUrl: string; serverUrl: string; code: string }): string {
  const first = opts.friendName.trim().split(/\s+/)[0] || "there";
  return [
    `Hi ${first}! I made an AI version of myself, and I'd love for you to talk with it. It looks and sounds like me, and it's clearly labelled as AI.`,
    "",
    `1. Install the cloneME app (Windows): ${opts.installerUrl}`,
    "2. Open it, choose \"I have an invite\", and paste this whole line:",
    `   ${joinLink(opts.serverUrl, opts.code)}`,
    "",
    `Or type the code ${opts.code} and the server address ${opts.serverUrl} yourself.`,
    "",
    `This invite is just for you, so please don't share it. - ${opts.ownerName}`,
  ].join("\n");
}
