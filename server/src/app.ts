import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import { z } from "zod";
import { AttemptLimiter, ensureOwner, findPersonByCode, signToken } from "./auth.js";
import { loadConfig, type Config } from "./config.js";
import { mediaDirOf, verifyMediaSignature } from "./media.js";
import { personaRouter } from "./persona/chat.js";
import { ownerRouter } from "./routes/owner.js";
import { endSession, publicPerson, sessionsRouter } from "./routes/sessions.js";
import { vendorStatus } from "./setup.js";
import { Store } from "./store.js";
import { createVendors } from "./vendors/index.js";
import type { Vendors } from "./vendors/types.js";

export interface AppContext {
  app: Express;
  config: Config;
  store: Store;
  vendors: Vendors;
  ownerBootstrap: { created: boolean; code?: string };
}

export function createApp(opts: { config?: Config; store?: Store; vendors?: Vendors } = {}): AppContext {
  const config = opts.config ?? loadConfig();
  const store = opts.store ?? new Store(config.dataDir, config.ownerName);
  const vendors = opts.vendors ?? createVendors(config);
  const ownerBootstrap = ensureOwner(store, config);
  if (!store.data.profile.displayName || store.data.profile.displayName === "Owner") {
    store.update((db) => {
      db.profile.displayName = config.ownerName;
    });
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.get("/healthz", (_req, res) => res.json({ ok: true, mode: vendorStatus({ config, store }).mode }));

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
  const owner = ownerRouter({ config, store, vendors });
  const ownerJson = express.json({ limit: "1mb" });
  app.use("/api/owner", (req, res, next) => (req.method === "PUT" && req.path === "/media" ? next() : ownerJson(req, res, next)), owner);
  app.use("/api", express.json({ limit: "64kb" }), sessionsRouter({ config, store, vendors }));
  app.use("/v1", express.json({ limit: "2mb" }), personaRouter({ config, store, llm: vendors.llm }));

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("unhandled error:", err.message);
    if (!res.headersSent) res.status(err instanceof SyntaxError ? 400 : 500).json({ error: "server_error" });
  });

  return { app, config, store, vendors, ownerBootstrap };
}
