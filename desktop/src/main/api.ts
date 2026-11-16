import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { MediaItem, MediaPurpose, Person, SessionInfo } from "../shared/bridge.js";

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
    public details?: unknown,
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

  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/+$/, "");
  }

  adopt(token: string) {
    this.tokens.set(token);
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
      throw new ApiError(humanMessage(res.status, code, json?.message), code, res.status, json);
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

  uploadFile(filePath: string, purpose: MediaPurpose, meta: UploadMeta = {}): Promise<MediaItem> {
    const size = statSync(filePath).size;
    return this.upload(Readable.toWeb(createReadStream(filePath)) as unknown as BodyInit, path.basename(filePath), mimeFor(filePath), size, purpose, meta);
  }

  uploadBytes(data: Uint8Array, filename: string, mimeType: string, purpose: MediaPurpose, meta: UploadMeta = {}): Promise<MediaItem> {
    return this.upload(data as unknown as BodyInit, filename, mimeType, data.byteLength, purpose, meta);
  }

  private upload(body: BodyInit, filename: string, mime: string, size: number, purpose: MediaPurpose, meta: UploadMeta) {
    const query = new URLSearchParams({ filename, purpose });
    if (meta.durationSec) query.set("durationSec", String(meta.durationSec));
    if (meta.durationEstimated) query.set("durationEstimated", "1");
    if (meta.promptId) query.set("promptId", meta.promptId);
    if (meta.promptKind) query.set("promptKind", meta.promptKind);
    if (meta.quality) query.set("quality", JSON.stringify(meta.quality).slice(0, 1400));
    return this.request<MediaItem>("PUT", `/api/owner/media?${query}`, undefined, {
      headers: { "content-type": mime, "content-length": String(size) },
      body,
      duplex: "half",
    } as RequestInit);
  }
}

export interface UploadMeta {
  durationSec?: number;
  durationEstimated?: boolean;
  promptId?: string;
  promptKind?: "reading" | "story" | "free";
  quality?: Record<string, unknown>;
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function humanMessage(status: number, code: string, serverMessage?: string): string {
  if (code === "invalid_setup_token") return "That setup token is not right. Copy SETUP_TOKEN again from your server's environment settings.";
  if (code === "already_claimed") return "This server already has an owner. Use \"I already set up\" and sign in with your owner code.";
  if (code === "precondition") return serverMessage ?? "Something is still missing.";
  if (code === "invalid_code") return "That invite code didn't work. Check it and try again.";
  if (code === "too_many_attempts") return "Too many tries. Wait a few minutes and try again.";
  if (code === "unauthorized") return "Your access has ended. Ask for a new invite code.";
  if (code === "busy") return serverMessage ?? "Too many calls right now. Try again in a few minutes.";
  if (code === "not_configured") return serverMessage ?? "This AI version isn't ready yet.";
  if (serverMessage) return serverMessage;
  return status >= 500 ? "The server had a problem. Try again in a moment." : `Request failed (${code}).`;
}
