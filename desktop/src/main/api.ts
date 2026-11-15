import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { MediaItem, MediaPurpose, Person, SessionInfo } from "../shared/bridge.js";

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".flac": "audio/flac", ".ogg": "audio/ogg", ".aac": "audio/aac",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".heic": "image/heic", ".webp": "image/webp",
  ".txt": "text/plain", ".md": "text/markdown", ".json": "application/octet-stream",
};

export const mimeFor = (file: string) => MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";

export interface TokenStore {
  get(): string | null;
  set(token: string | null): void;
}

export class ApiClient {
  constructor(
    public baseUrl: string,
    private tokens: TokenStore,
    private onUnauthorized: () => void = () => {},
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  get signedIn() {
    return this.tokens.get() !== null;
  }

  signOut() {
    this.tokens.set(null);
  }

  async request<T>(method: string, route: string, body?: unknown, init: RequestInit = {}): Promise<T> {
    const token = this.tokens.get();
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${route}`, {
        ...init,
        method,
        headers,
        body: body === undefined ? init.body : JSON.stringify(body),
      });
    } catch {
      throw new ApiError("Cannot reach the server. Check your internet connection.", "network", 0);
    }
    const text = await res.text();
    const json = text ? safeJson(text) : {};
    if (!res.ok) {
      const code = String(json?.error ?? "error");
      if (res.status === 401 && token) {
        this.tokens.set(null);
        this.onUnauthorized();
      }
      throw new ApiError(humanMessage(res.status, code, json?.message), code, res.status);
    }
    return json as T;
  }

  async redeem(code: string): Promise<Person> {
    const out = await this.request<{ token: string; person: Person }>("POST", "/api/auth/redeem", { code: code.trim() });
    this.tokens.set(out.token);
    return out.person;
  }

  me() {
    return this.request<{ person: Person; mock: boolean; readyForCalls: boolean }>("GET", "/api/me");
  }

  startSession() {
    return this.request<SessionInfo>("POST", "/api/sessions", {});
  }

  endSession(id: string) {
    return this.request<{ ok: true }>("POST", `/api/sessions/${encodeURIComponent(id)}/end`, {});
  }

  sendText(id: string, text: string) {
    return this.request<{ reply: string }>("POST", `/api/sessions/${encodeURIComponent(id)}/text`, { text });
  }

  async uploadFile(filePath: string, purpose: MediaPurpose): Promise<MediaItem> {
    const size = statSync(filePath).size;
    const query = new URLSearchParams({ filename: path.basename(filePath), purpose });
    return this.request<MediaItem>("PUT", `/api/owner/media?${query}`, undefined, {
      headers: { "content-type": mimeFor(filePath), "content-length": String(size) },
      body: Readable.toWeb(createReadStream(filePath)) as unknown as BodyInit,
      duplex: "half",
    } as RequestInit);
  }
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function humanMessage(status: number, code: string, serverMessage?: string): string {
  if (code === "invalid_code") return "That invite code didn't work. Check it and try again.";
  if (code === "too_many_attempts") return "Too many tries. Wait a few minutes and try again.";
  if (code === "unauthorized") return "Your access has ended. Ask for a new invite code.";
  if (code === "busy") return serverMessage ?? "Too many calls right now. Try again in a few minutes.";
  if (code === "not_configured") return serverMessage ?? "This AI version isn't ready yet.";
  if (serverMessage) return serverMessage;
  return status >= 500 ? "The server had a problem. Try again in a moment." : `Request failed (${code}).`;
}
