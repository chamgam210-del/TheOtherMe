import { Router } from "express";
import { z } from "zod";
import { advanceBuild, BuildPreconditionError, buildStatus, confirmVoiceVerification, resetBuildErrors, STAGES } from "../build.js";
import { applyVendorKeys, clearVendorKey, type Config, type VendorKeys } from "../config.js";
import { effectiveIds, vendorStatus } from "../setup.js";
import type { SecretStore } from "../secrets.js";
import type { Store } from "../store.js";
import { verifyVendorKey, type KeyVerification, type VendorId } from "../vendors/verify.js";
import type { FetchLike, Vendors } from "../vendors/types.js";

export interface OnboardingDeps {
  config: Config;
  store: Store;
  vendors: Vendors;
  secrets: SecretStore;
  fetchImpl: FetchLike;
}

const VENDORS: VendorId[] = ["tavus", "elevenlabs", "deepgram", "llm"];
const keyStr = z.string().trim().min(8).max(400).regex(/^\S+$/, "Keys cannot contain spaces");

const keysBody = z.object({
  tavus: keyStr.optional(),
  elevenlabs: keyStr.optional(),
  deepgram: keyStr.optional(),
  llm: z
    .object({
      apiKey: keyStr.optional(),
      baseUrl: z.string().trim().url().max(200).optional(),
      model: z.string().trim().min(1).max(100).optional(),
    })
    .optional(),
});

const stateBody = z.object({
  consentAccepted: z.boolean().optional(),
  consentName: z.string().trim().min(2).max(120).optional(),
  currentStep: z.string().max(40).optional(),
  skipped: z.record(z.string().max(40), z.boolean()).optional(),
  avoidNone: z.boolean().optional(),
  completed: z.boolean().optional(),
});

export function onboardingRouter(deps: OnboardingDeps): Router {
  const { config, store, vendors, secrets, fetchImpl } = deps;
  const router = Router();

  const keyView = () => {
    const stored = secrets.load();
    const v = config.vendors;
    const source = (vendor: VendorId) => {
      const viaApp = vendor === "llm" ? stored.llm?.apiKey : stored[vendor];
      return v[vendor].apiKey ? (viaApp ? "app" : "environment") : null;
    };
    return {
      mockMode: config.forceMock,
      vendors: Object.fromEntries(
        VENDORS.map((vendor) => [vendor, { configured: Boolean(v[vendor].apiKey), source: source(vendor), check: store.data.onboarding.keyChecks[vendor] ?? null }]),
      ),
      llm: { baseUrl: v.llm.baseUrl, model: v.llm.model },
    };
  };

  async function check(vendor: VendorId, key: string, llm = config.vendors.llm): Promise<KeyVerification> {
    if (config.forceMock) return { ok: true, message: "Mock mode is on, so the key was not checked against the vendor." };
    return verifyVendorKey(vendor, fetchImpl, key, { baseUrl: llm.baseUrl, model: llm.model });
  }

  const remember = (vendor: VendorId, result: KeyVerification) =>
    store.update((db) => {
      db.onboarding.keyChecks[vendor] = { ...result, checkedAt: new Date().toISOString() };
    });

  router.get("/keys", (_req, res) => res.json(keyView()));

  router.put("/keys", async (req, res) => {
    const parsed = keysBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", message: parsed.error.issues[0]?.message ?? "Check the key you pasted." });
      return;
    }
    const input = parsed.data;
    const results: Record<string, KeyVerification> = {};
    const accepted: VendorKeys = {};
    const llmCfg = { ...config.vendors.llm, ...(input.llm?.baseUrl ? { baseUrl: input.llm.baseUrl } : {}), ...(input.llm?.model ? { model: input.llm.model } : {}) };

    await Promise.all(
      (["tavus", "elevenlabs", "deepgram"] as const).map(async (vendor) => {
        const key = input[vendor];
        if (!key) return;
        results[vendor] = await check(vendor, key);
        if (results[vendor]!.ok) accepted[vendor] = key;
      }),
    );
    if (input.llm?.apiKey) {
      results.llm = await check("llm", input.llm.apiKey, llmCfg);
      if (results.llm.ok) accepted.llm = { apiKey: input.llm.apiKey, baseUrl: input.llm.baseUrl, model: input.llm.model };
    } else if (input.llm?.baseUrl || input.llm?.model) {
      accepted.llm = { baseUrl: input.llm.baseUrl, model: input.llm.model };
    }

    // Only keys that passed a live test are saved; nothing half-valid ends up on disk.
    if (Object.keys(accepted).length) {
      secrets.update((current) => ({ ...current, ...accepted, llm: { ...current.llm, ...accepted.llm } }));
      applyVendorKeys(config, accepted);
    }
    for (const [vendor, result] of Object.entries(results)) remember(vendor as VendorId, result);
    res.status(Object.values(results).some((r) => !r.ok) ? 422 : 200).json({ results, ...keyView() });
  });

  router.post("/keys/verify", async (req, res) => {
    const only = typeof req.body?.vendor === "string" ? (req.body.vendor as VendorId) : undefined;
    const results: Record<string, KeyVerification> = {};
    for (const vendor of VENDORS.filter((v) => !only || v === only)) {
      const key = config.vendors[vendor].apiKey;
      if (!key) {
        results[vendor] = { ok: false, message: "No key saved yet." };
        continue;
      }
      results[vendor] = await check(vendor, key);
      remember(vendor, results[vendor]!);
    }
    res.json({ results, ...keyView() });
  });

  router.delete("/keys/:vendor", (req, res) => {
    const vendor = req.params.vendor as VendorId;
    if (!VENDORS.includes(vendor)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    secrets.update((current) => {
      const next = { ...current };
      delete next[vendor];
      return next;
    });
    clearVendorKey(config, vendor);
    store.update((db) => delete db.onboarding.keyChecks[vendor]);
    res.json(keyView());
  });

  router.get("/onboarding", (_req, res) => {
    const db = store.data;
    const voice = db.media.filter((m) => m.purpose === "voice" && m.kind === "audio");
    const ownerId = db.people.find((p) => p.role === "owner")?.id;
    res.json({
      state: { ...db.onboarding, keyChecks: undefined },
      facts: {
        keys: Object.fromEntries(VENDORS.map((v) => [v, Boolean(config.vendors[v].apiKey) && db.onboarding.keyChecks[v]?.ok !== false])),
        keyWarnings: Object.fromEntries(VENDORS.map((v) => [v, db.onboarding.keyChecks[v]?.warning ?? null])),
        mockMode: config.forceMock,
        voiceSeconds: Math.round(voice.reduce((a, m) => a + (m.durationSec ?? 0), 0)),
        voiceClips: voice.map((m) => ({ id: m.id, promptId: m.promptId ?? null, durationSec: m.durationSec ?? 0, estimated: Boolean(m.durationEstimated), filename: m.filename, quality: m.quality ?? null })),
        replicaVideo: db.media.find((m) => m.purpose === "replica" && m.kind === "video") ?? null,
        consentVideo: db.media.find((m) => m.purpose === "consent" && m.kind === "video") ?? null,
        optionalUploads: db.media.filter((m) => m.purpose === "training").length,
        profile: { displayName: db.profile.displayName, answers: db.profile.answers ?? {}, family: db.profile.family, avoidTopics: db.profile.avoidTopics },
        people: db.people.filter((p) => p.role !== "owner" && !p.revoked).length,
        testCalls: db.sessions.filter((s) => s.personId === ownerId && s.status === "ended").length,
        ready: vendorStatus({ config, store }).readyForCalls,
        ids: effectiveIds(config, store),
      },
      installerUrl: config.installerUrl,
      serverUrl: config.publicBaseUrl,
    });
  });

  router.put("/onboarding", (req, res) => {
    const parsed = stateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const b = parsed.data;
    store.update((db) => {
      const o = db.onboarding;
      if (b.consentAccepted === true) {
        o.consentAcceptedAt ??= new Date().toISOString();
        if (b.consentName) o.consentName = b.consentName;
      } else if (b.consentAccepted === false) {
        o.consentAcceptedAt = undefined;
      }
      if (b.currentStep) o.currentStep = b.currentStep;
      if (b.skipped) Object.assign(o.skipped, b.skipped);
      if (b.avoidNone !== undefined) o.avoidNone = b.avoidNone;
      if (b.completed !== undefined) o.completedAt = b.completed ? (o.completedAt ?? new Date().toISOString()) : undefined;
    });
    res.json({ ok: true, state: { ...store.data.onboarding, keyChecks: undefined } });
  });

  const sd = () => ({ config, store, vendors });
  const guard = (fn: () => Promise<unknown>) => async (_req: unknown, res: any) => {
    try {
      res.json(await fn());
    } catch (err) {
      if (err instanceof BuildPreconditionError) res.status(409).json({ error: "precondition", message: err.message });
      else {
        console.error("build failure:", (err as Error).message);
        res.status(502).json({ error: "vendor_failure", message: (err as Error).message });
      }
    }
  };

  router.get("/build", guard(() => advanceBuild(sd())));
  router.post("/build/start", guard(() => advanceBuild(sd(), { start: true, sync: true })));
  router.post("/build/verified", guard(() => confirmVoiceVerification(sd())));
  router.post("/build/retry", async (req, res) => {
    const stage = String(req.body?.stage ?? "");
    if (!(STAGES as readonly string[]).includes(stage)) {
      res.status(400).json({ error: "invalid_stage" });
      return;
    }
    resetBuildErrors(store, stage as (typeof STAGES)[number]);
    store.update((db) => {
      if (stage === "voice") db.vendor.voiceId = undefined;
      if (stage === "replica") db.vendor.replicaId = undefined;
      if (stage === "persona") db.vendor.personaId = undefined;
    });
    await guard(() => advanceBuild(sd(), { sync: true }))(req, res);
  });
  router.get("/build/summary", (_req, res) => res.json(buildStatus(config, store)));

  return router;
}
