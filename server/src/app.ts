import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import { z } from "zod";
import { AttemptLimiter, claimOwner, ensureInstanceSecrets, ensureOwner, findPersonByCode, safeCompare, signToken } from "./auth.js";
import { applyVendorKeys, loadConfig, type Config } from "./config.js";
import { SecretStore } from "./secrets.js";
import { mediaDirOf, verifyMediaSignature } from "./media.js";
import { personaRouter } from "./persona/chat.js";
import { ownerRouter } from "./routes/owner.js";
import { endSession, publicPerson, sessionsRouter } from "./routes/sessions.js";
import { vendorStatus } from "./setup.js";
import { Store } from "./store.js";
import { createVendors } from "./vendors/index.js";
import type { FetchLike, Vendors } from "./vendors/types.js";

export interface AppContext {
  app: Express;
  config: Config;
  store: Store;
  vendors: Vendors;
  ownerBootstrap: { created: boolean; code?: string; awaitingClaim?: boolean };
}

export function createApp(opts: { config?: Config; store?: Store; vendors?: Vendors; fetchImpl?: FetchLike } = {}): AppContext {
  const config = opts.config ?? loadConfig();
  const store = opts.store ?? new Store(config.dataDir, config.ownerName);
  ensureInstanceSecrets(store, config);
  const secrets = new SecretStore(config.dataDir, config.sessionSecret);
  applyVendorKeys(config, secrets.load());
  const vendors = opts.vendors ?? createVendors(config);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ownerBootstrap = ensureOwner(store, config);
  if (!store.data.profile.displayName || store.data.profile.displayName === "Owner") {
    store.update((db) => {
      db.profile.displayName = config.ownerName;
    });
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  const claimed = () => store.data.people.some((p) => p.role === "owner");
  app.get("/healthz", (_req, res) =>
    res.json({
      ok: true,
      app: "cloneme",
      mode: vendorStatus({ config, store }).mode,
      claimed: claimed(),
      claimable: !claimed() && Boolean(config.setupToken),
      https: config.publicBaseUrl.startsWith("https://"),
      publicBaseUrl: config.publicBaseUrl,
      persistentStorage: config.persistentStorage,
    }),
  );

  const claimLimiter = new AttemptLimiter(8, 15 * 60 * 1000);
  app.post("/api/setup/claim", express.json({ limit: "4kb" }), (req, res) => {
    const parsed = z.object({ setupToken: z.string().min(8).max(200), ownerName: z.string().trim().min(1).max(80) }).safeParse(req.body);
    const key = req.ip ?? "unknown";
    if (claimed()) {
      res.status(409).json({ error: "already_claimed", message: "This server already has an owner. Sign in with your owner code instead." });
      return;
    }
    if (!config.setupToken) {
      res.status(404).json({ error: "claim_disabled", message: "This server was not deployed with a setup token." });
      return;
    }
    if (claimLimiter.blocked(key)) {
      res.status(429).json({ error: "too_many_attempts" });
      return;
    }
    if (!parsed.success || !safeCompare(parsed.data.setupToken.trim(), config.setupToken)) {
      claimLimiter.fail(key);
      res.status(401).json({ error: "invalid_setup_token", message: "That setup token is not right. Copy SETUP_TOKEN from your host's environment settings." });
      return;
    }
    const { person, code } = claimOwner(store, parsed.data.ownerName);
    res.status(201).json({ token: signToken(config, person.id), inviteCode: code, person: publicPerson(person, store.data.profile.displayName) });
  });

  // Vendors fetch replica training videos through short-lived signed links.
  app.get("/media/:id", (req, res) => {
    const item = store.data.media.find((m) => m.id === req.params.id);
    const file = item && path.join(mediaDirOf(config), item.storedAs);
    if (!item || !file || !existsSync(file) || !verifyMediaSignature(config, item.id, String(req.query.exp ?? ""), String(req.query.sig ?? ""))) {
      res.status(404).end();
      return;
    }
    res.type(item.mimeType);
    createReadStream(file).pipe(res);
  });

  const limiter = new AttemptLimiter();
  app.post("/api/auth/redeem", express.json({ limit: "4kb" }), (req, res) => {
    const parsed = z.object({ code: z.string().min(4).max(64) }).safeParse(req.body);
    const key = req.ip ?? "unknown";
    if (limiter.blocked(key)) {
      res.status(429).json({ error: "too_many_attempts" });
      return;
    }
    const person = parsed.success ? findPersonByCode(store, parsed.data.code) : undefined;
    if (!person || person.revoked) {
      limiter.fail(key);
      res.status(401).json({ error: "invalid_code" });
      return;
    }
    limiter.reset(key);
    store.update(() => {
      person.lastSeenAt = new Date().toISOString();
    });
    res.json({ token: signToken(config, person.id), person: publicPerson(person, store.data.profile.displayName) });
  });

  app.post("/webhooks/tavus", express.json({ limit: "256kb" }), async (req, res) => {
    if (config.tavusWebhookSecret && req.query.secret !== config.tavusWebhookSecret) {
      res.status(401).end();
      return;
    }
    const conversationId = req.body?.conversation_id;
    const event = String(req.body?.event_type ?? "");
    const session = store.data.sessions.find((s) => s.conversationId === conversationId);
    if (session && event.includes("shutdown")) await endSession(store, vendors, session);
    res.json({ ok: true });
  });

  // Owner media uploads are raw request bodies, so the JSON parser skips PUT /media.
  const owner = ownerRouter({ config, store, vendors, secrets, fetchImpl });
  const ownerJson = express.json({ limit: "1mb" });
  app.use("/api/owner", (req, res, next) => (req.method === "PUT" && req.path === "/media" ? next() : ownerJson(req, res, next)), owner);
  app.use("/api", express.json({ limit: "64kb" }), sessionsRouter({ config, store, vendors }));
  app.use("/v1", express.json({ limit: "2mb" }), personaRouter({ config, store, get llm() { return vendors.llm; } }));

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("unhandled error:", err.message);
    if (!res.headersSent) res.status(err instanceof SyntaxError ? 400 : 500).json({ error: "server_error" });
  });

  return { app, config, store, vendors, ownerBootstrap };
}
