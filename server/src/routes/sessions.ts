import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth.js";
import type { Config } from "../config.js";
import { buildConversationalContext, buildGreeting } from "../persona/prompt.js";
import { collectReply } from "../persona/chat.js";
import { getMemory, summarizeSession } from "../persona/memory.js";
import { effectiveIds, vendorStatus } from "../setup.js";
import { newId, type Person, type SessionRecord, type Store } from "../store.js";
import type { Vendors } from "../vendors/types.js";
import { VendorError } from "../vendors/types.js";

export const participantTag = (personId: string) => `p_${personId}`;

const isLive = (config: Config, s: SessionRecord, now = Date.now()) =>
  s.status === "active" && now < Date.parse(s.startedAt) + (config.maxCallSeconds + 60) * 1000;

export async function endSession(store: Store, vendors: Vendors, session: SessionRecord) {
  if (session.status === "ended") return;
  store.update(() => {
    session.status = "ended";
    session.endedAt = new Date().toISOString();
  });
  if (!session.mock) await vendors.tavus.endConversation(session.conversationId).catch(() => undefined);
  const person = store.data.people.find((p) => p.id === session.personId);
  if (person) await summarizeSession(store, vendors.llm, person, session.startedAt).catch(() => undefined);
}

export function publicPerson(person: Person, ownerName: string) {
  return {
    id: person.id,
    name: person.name,
    role: person.role,
    relationship: person.relationship,
    aiBanner: person.aiBanner,
    ownerName,
  };
}

const textBody = z.object({ text: z.string().trim().min(1).max(2000) });

export function sessionsRouter(deps: { config: Config; store: Store; vendors: Vendors }): Router {
  const { config, store, vendors } = deps;
  const router = Router();
  router.use(authenticate(config, store));

  router.get("/me", (req, res) => {
    const person = req.person!;
    store.update(() => {
      person.lastSeenAt = new Date().toISOString();
    });
    res.json({
      person: publicPerson(person, store.data.profile.displayName),
      mock: vendors.tavus.mock,
      readyForCalls: vendors.tavus.mock || vendorStatus({ config, store }).readyForCalls,
    });
  });

  router.post("/sessions", async (req, res) => {
    const person = req.person!;
    const ids = effectiveIds(config, store);
    const replicaId = ids.replicaId ?? (vendors.tavus.mock ? "mock_replica" : undefined);
    const personaId = ids.personaId ?? (vendors.tavus.mock ? "mock_persona" : undefined);
    if (!replicaId || !personaId) {
      res.status(503).json({ error: "not_configured", message: "The AI version is not set up yet." });
      return;
    }

    for (const s of store.data.sessions.filter((s) => s.personId === person.id && s.status === "active")) {
      await endSession(store, vendors, s);
    }
    const active = store.data.sessions.filter((s) => isLive(config, s)).length;
    if (active >= config.maxConcurrentSessions) {
      res.status(429).json({ error: "busy", message: "Too many calls right now. Try again in a few minutes." });
      return;
    }

    const profile = store.data.profile;
    const greeting = buildGreeting(profile, person, getMemory(store, person.id));
    const started = performance.now();
    try {
      const convo = await vendors.tavus.createConversation({
        replicaId,
        personaId,
        conversationName: `${profile.displayName} x ${person.name}`,
        conversationalContext: buildConversationalContext(profile, person),
        customGreeting: greeting,
        participantTag: participantTag(person.id),
        maxCallSeconds: config.maxCallSeconds,
        callbackUrl: config.tavusWebhookSecret
          ? `${config.publicBaseUrl}/webhooks/tavus?secret=${encodeURIComponent(config.tavusWebhookSecret)}`
          : undefined,
      });
      const record: SessionRecord = {
        id: newId("ses"),
        personId: person.id,
        conversationId: convo.conversationId,
        conversationUrl: convo.conversationUrl,
        mock: vendors.tavus.mock,
        status: "active",
        startedAt: new Date().toISOString(),
        tavusCreateMs: Math.round(performance.now() - started),
      };
      store.update((db) => db.sessions.push(record));
      res.status(201).json({
        sessionId: record.id,
        conversationUrl: record.conversationUrl,
        mock: record.mock,
        greeting,
        maxCallSeconds: config.maxCallSeconds,
        banner: person.aiBanner ? { text: `AI version of ${profile.displayName}` } : null,
      });
    } catch (err) {
      const detail = err instanceof VendorError ? `${err.vendor} error` : "unexpected error";
      console.error("session create failed:", (err as Error).message);
      res.status(502).json({ error: "vendor_failure", message: `Could not start the call (${detail}).` });
    }
  });

  const mySession = (req: { person?: Person; params: Record<string, any> }) => {
    const s = store.data.sessions.find((x) => x.id === req.params.id);
    return s && s.personId === req.person!.id ? s : undefined;
  };

  router.post("/sessions/:id/end", async (req, res) => {
    const session = mySession(req);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await endSession(store, vendors, session);
    res.json({ ok: true });
  });

  router.post("/sessions/:id/text", async (req, res) => {
    const session = mySession(req);
    const parsed = textBody.safeParse(req.body);
    if (!session || session.status !== "active") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    try {
      const reply = await collectReply({ config, store, llm: vendors.llm }, req.person!.id, [
        { role: "user", content: parsed.data.text },
      ]);
      res.json({ reply });
    } catch (err) {
      console.error("text fallback failed:", (err as Error).message);
      res.status(502).json({ error: "llm_failure" });
    }
  });

  return router;
}
