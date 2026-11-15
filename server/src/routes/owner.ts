import { Router } from "express";
import { z } from "zod";
import { addPerson, authenticate, generateInviteCode, hashCode, requireOwner } from "../auth.js";
import type { Config } from "../config.js";
import { deleteMedia, mediaDirOf, saveUpload, UploadTooLarge } from "../media.js";
import { clearMemory } from "../persona/memory.js";
import {
  SetupError,
  setupPersona,
  setupReplica,
  setupVoice,
  syncVendorStatus,
  trainVoice,
  vendorStatus,
} from "../setup.js";
import type { Store } from "../store.js";
import { startTraining } from "../training/pipeline.js";
import type { Vendors } from "../vendors/types.js";
import { endSession } from "./sessions.js";

const profileBody = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  basics: z.string().max(6000).optional(),
  birthplace: z.string().max(120).optional(),
  occupation: z.string().max(200).optional(),
  family: z
    .array(z.object({ name: z.string().trim().min(1).max(80), relationship: z.string().trim().min(1).max(60), notes: z.string().max(500).optional() }))
    .max(60)
    .optional(),
  avoidTopics: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
});

const personBody = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.enum(["family", "friend"]),
  relationship: z.string().trim().max(60).optional(),
  aiBanner: z.boolean().optional(),
});

const MEDIA_KINDS = ["audio", "video", "photo", "text"] as const;
const PURPOSES = ["training", "voice", "replica", "consent"] as const;

export function ownerRouter(deps: { config: Config; store: Store; vendors: Vendors }): Router {
  const { config, store, vendors } = deps;
  const router = Router();
  router.use(authenticate(config, store), requireOwner);

  const publicPerson = (p: (typeof store.data.people)[number]) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    relationship: p.relationship,
    aiBanner: p.aiBanner,
    revoked: p.revoked,
    createdAt: p.createdAt,
    lastSeenAt: p.lastSeenAt ?? null,
    hasMemory: Boolean(store.data.memories[p.id]),
  });

  router.get("/profile", (_req, res) => res.json(store.data.profile));

  router.put("/profile", (req, res) => {
    const parsed = profileBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    store.update((db) => {
      db.profile = { ...db.profile, ...parsed.data, updatedAt: new Date().toISOString() };
    });
    res.json(store.data.profile);
  });

  router.get("/style", (_req, res) => res.json({ style: store.data.style }));

  router.get("/facts", (_req, res) => res.json({ facts: store.data.facts }));

  router.patch("/facts/:id", (req, res) => {
    const parsed = z.object({ status: z.enum(["approved", "rejected", "pending"]).optional(), text: z.string().trim().min(1).max(300).optional() }).safeParse(req.body);
    const fact = store.data.facts.find((f) => f.id === req.params.id);
    if (!parsed.success || !fact) {
      res.status(parsed.success ? 404 : 400).json({ error: parsed.success ? "not_found" : "invalid_body" });
      return;
    }
    store.update(() => Object.assign(fact, parsed.data));
    res.json(fact);
  });

  router.get("/people", (_req, res) => res.json({ people: store.data.people.map(publicPerson) }));

  router.post("/people", (req, res) => {
    const parsed = personBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    const { person, code } = addPerson(store, parsed.data);
    res.status(201).json({ person: publicPerson(person), inviteCode: code });
  });

  router.patch("/people/:id", (req, res) => {
    const parsed = z.object({ aiBanner: z.boolean().optional(), relationship: z.string().trim().max(60).optional() }).safeParse(req.body);
    const person = store.data.people.find((p) => p.id === req.params.id);
    if (!parsed.success || !person) {
      res.status(parsed.success ? 404 : 400).json({ error: parsed.success ? "not_found" : "invalid_body" });
      return;
    }
    store.update(() => Object.assign(person, parsed.data));
    res.json(publicPerson(person));
  });

  router.post("/people/:id/code", (req, res) => {
    const person = store.data.people.find((p) => p.id === req.params.id);
    if (!person) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const code = generateInviteCode();
    store.update(() => {
      person.codeHash = hashCode(code);
      person.revoked = false;
    });
    res.json({ inviteCode: code });
  });

  router.delete("/people/:id", async (req, res) => {
    const person = store.data.people.find((p) => p.id === req.params.id);
    if (!person) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (person.role === "owner") {
      res.status(400).json({ error: "cannot_revoke_owner" });
      return;
    }
    store.update(() => {
      person.revoked = true;
    });
    for (const s of store.data.sessions.filter((s) => s.personId === person.id && s.status === "active")) {
      await endSession(store, vendors, s);
    }
    res.json({ ok: true });
  });

  router.delete("/people/:id/memory", (req, res) => {
    clearMemory(store, req.params.id!);
    res.json({ ok: true });
  });

  router.get("/media", (_req, res) => res.json({ media: store.data.media }));

  router.put("/media", async (req, res) => {
    const filename = String(req.query.filename ?? "");
    const kind = req.query.kind ? String(req.query.kind) : undefined;
    const purpose = String(req.query.purpose ?? "training");
    const speaker = req.query.ownerSpeaker !== undefined ? Number(req.query.ownerSpeaker) : undefined;
    if (!filename || !(PURPOSES as readonly string[]).includes(purpose) || (kind && !(MEDIA_KINDS as readonly string[]).includes(kind))) {
      res.status(400).json({ error: "invalid_query", message: "filename, purpose (training|voice|replica|consent) and optional kind are required" });
      return;
    }
    try {
      const item = await saveUpload(req, config, store, {
        filename,
        kind: kind as (typeof MEDIA_KINDS)[number] | undefined,
        purpose: purpose as (typeof PURPOSES)[number],
        ownerSpeaker: speaker !== undefined && Number.isInteger(speaker) ? speaker : undefined,
      });
      res.status(201).json(item);
    } catch (err) {
      if (err instanceof UploadTooLarge) res.status(413).json({ error: "too_large" });
      else res.status(400).json({ error: "upload_failed", message: (err as Error).message });
    }
  });

  router.delete("/media/:id", async (req, res) => {
    res.status((await deleteMedia(config, store, req.params.id!)) ? 200 : 404).json({ ok: true });
  });

  router.post("/training/run", (req, res) => {
    const { started } = startTraining({ store, vendors, mediaDir: mediaDirOf(config) }, { force: Boolean(req.body?.force) });
    res.status(started ? 202 : 409).json({ started });
  });

  router.get("/training/jobs", (_req, res) => res.json({ jobs: store.data.jobs.slice(-10).reverse() }));

  router.get("/vendors", async (req, res) => {
    res.json(req.query.sync ? await syncVendorStatus({ config, store, vendors }).catch(() => vendorStatus({ config, store })) : vendorStatus({ config, store }));
  });

  const setupRoute = (fn: (opts?: any) => Promise<unknown>) => async (req: any, res: any) => {
    try {
      res.json(await fn(req.body));
    } catch (err) {
      if (err instanceof SetupError) res.status(400).json({ error: err.code, message: err.message });
      else {
        console.error("setup failure:", (err as Error).message);
        res.status(502).json({ error: "vendor_failure", message: (err as Error).message });
      }
    }
  };
  const sd = { config, store, vendors };
  router.post("/vendors/voice", setupRoute((b) => setupVoice(sd, b)));
  router.post("/vendors/voice/train", setupRoute(() => trainVoice(sd)));
  router.post("/vendors/replica", setupRoute((b) => setupReplica(sd, b)));
  router.post("/vendors/persona", setupRoute(() => setupPersona(sd)));

  return router;
}
