import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Config } from "./config.js";
import { newId, type Person, type Role, type Store } from "./store.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateInviteCode(): string {
  const chunk = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${chunk()}-${chunk()}-${chunk()}`;
}

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashCode(code: string): string {
  return createHash("sha256").update(normalizeCode(code)).digest("hex");
}

const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

export function findPersonByCode(store: Store, code: string): Person | undefined {
  const hash = hashCode(code);
  return store.data.people.find((p) => safeEqual(p.codeHash, hash));
}

export function addPerson(
  store: Store,
  input: { name: string; role: Role; relationship?: string; aiBanner?: boolean },
): { person: Person; code: string } {
  const code = generateInviteCode();
  const person: Person = {
    id: newId("per"),
    name: input.name.trim(),
    role: input.role,
    relationship: input.relationship?.trim() || (input.role === "family" ? "family" : input.role),
    codeHash: hashCode(code),
    aiBanner: input.aiBanner ?? input.role === "friend",
    revoked: false,
    createdAt: new Date().toISOString(),
  };
  store.update((db) => db.people.push(person));
  return { person, code };
}

/** Generates and persists the signing secrets when the host did not provide them. Must run before any token is signed. */
export function ensureInstanceSecrets(store: Store, config: Config): void {
  if (!config.sessionSecretFromEnv) {
    if (!store.data.instance.sessionSecret) store.update((db) => (db.instance.sessionSecret = randomBytes(32).toString("hex")));
    config.sessionSecret = store.data.instance.sessionSecret!;
  }
  if (!config.personaSecretFromEnv) {
    if (!store.data.instance.personaSecret) store.update((db) => (db.instance.personaSecret = randomBytes(24).toString("hex")));
    config.personaSharedSecret = store.data.instance.personaSecret!;
  }
}

export function ensureOwner(store: Store, config: Config): { created: boolean; code?: string; awaitingClaim?: boolean } {
  const existing = store.data.people.find((p) => p.role === "owner");
  if (existing) {
    if (config.ownerInviteCode && existing.codeHash !== hashCode(config.ownerInviteCode)) {
      store.update(() => {
        existing.codeHash = hashCode(config.ownerInviteCode!);
      });
    }
    return { created: false };
  }
  if (config.setupToken && !config.ownerInviteCode) return { created: false, awaitingClaim: true };
  const code = config.ownerInviteCode ?? generateInviteCode();
  const person: Person = {
    id: newId("per"),
    name: config.ownerName,
    role: "owner",
    relationship: "self",
    codeHash: hashCode(code),
    aiBanner: false,
    revoked: false,
    createdAt: new Date().toISOString(),
  };
  store.update((db) => db.people.push(person));
  return { created: true, code: config.ownerInviteCode ? undefined : code };
}

interface TokenPayload {
  pid: string;
  exp: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signToken(config: Config, personId: string, now = Date.now()): string {
  const payload: TokenPayload = { pid: personId, exp: Math.floor(now / 1000) + config.tokenTtlSeconds };
  const body = b64(JSON.stringify(payload));
  const sig = createHmac("sha256", config.sessionSecret).update(body).digest();
  return `${body}.${b64(sig)}`;
}

export function verifyToken(config: Config, token: string, now = Date.now()): TokenPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = b64(createHmac("sha256", config.sessionSecret).update(body).digest());
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
    if (typeof payload.pid !== "string" || payload.exp * 1000 < now) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Counts failed redemptions per client so invite codes cannot be brute-forced. */
export class AttemptLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max = 10,
    private windowMs = 15 * 60 * 1000,
  ) {}

  private recent(key: string, now: number) {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, list);
    return list;
  }

  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }

  fail(key: string, now = Date.now()): void {
    this.recent(key, now).push(now);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

declare module "express-serve-static-core" {
  interface Request {
    person?: Person;
  }
}

export function authenticate(config: Config, store: Store) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const payload = token ? verifyToken(config, token) : null;
    const person = payload ? store.data.people.find((p) => p.id === payload.pid) : undefined;
    if (!person || person.revoked) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    req.person = person;
    next();
  };
}

export function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (req.person?.role !== "owner") {
    res.status(403).json({ error: "owner_only" });
    return;
  }
  next();
}

export function claimOwner(store: Store, name: string): { person: Person; code: string } {
  const code = generateInviteCode();
  const person: Person = {
    id: newId("per"),
    name: name.trim(),
    role: "owner",
    relationship: "self",
    codeHash: hashCode(code),
    aiBanner: false,
    revoked: false,
    createdAt: new Date().toISOString(),
  };
  store.update((db) => {
    db.people.push(person);
    db.profile.displayName = person.name;
  });
  return { person, code };
}

export const safeCompare = safeEqual;
