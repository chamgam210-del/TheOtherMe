import type { BuildStatus, Bridge, KeyResult, KeysStatus, MediaPurpose, OnboardingData, Person, ServerCheck, VendorName } from "../shared/bridge.js";
import { normalizeServerUrl } from "../shared/invite.js";
import { ApiClient, ApiError } from "./api.js";
import { KeyStage } from "./keyStage.js";
import { mediaDuration } from "./mediaDuration.js";
import type { Settings } from "./settings.js";

const VENDOR_NAMES: VendorName[] = ["tavus", "elevenlabs", "deepgram", "llm"];

export interface HandlerDeps {
  api: ApiClient;
  version: string;
  settings: Settings;
  /** Defaults to a fresh stage; injectable for tests. */
  keyStage?: KeyStage;
  fetchImpl?: typeof fetch;
  openExternal?(url: string): Promise<void> | void;
  /** Shows the native multi-file picker; returns chosen absolute paths. */
  pickFiles(purpose: MediaPurpose): Promise<string[]>;
}

export function createHandlers({ api, version, settings, keyStage, fetchImpl = fetch, openExternal = () => undefined, pickFiles }: HandlerDeps): Bridge {
  let person: Person | null = null;
  const stage = keyStage ?? new KeyStage(fetchImpl);

  async function flushStagedKeys(): Promise<Record<string, KeyResult>> {
    const pending = stage.take();
    if (!pending) return {};
    try {
      const out = await api.request<{ results: Record<string, KeyResult> }>("PUT", "/api/owner/keys", pending);
      stage.clear();
      return out.results;
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        const results = (err.details as { results?: Record<string, KeyResult> })?.results ?? {};
        stage.clear(VENDOR_NAMES.filter((v) => results[v]?.ok !== false));
        return results;
      }
      throw err;
    }
  }
  const owner = <T>(method: string, route: string, body?: unknown) => api.request<T>(method, `/api/owner${route}`, body);

  const handlers: Bridge = {
    async getState() {
      if (api.signedIn && !person) {
        person = (await api.me().catch(() => null))?.person ?? null;
      }
      return { apiBaseUrl: api.baseUrl, person: api.signedIn ? person : null, version, serverUrl: settings.serverUrl ?? null };
    },
    async signIn(code, serverUrl) {
      if (serverUrl) {
        const url = normalizeServerUrl(serverUrl);
        if (!url) throw new ApiError("That server address does not look right.", "invalid_url", 0);
        const previous = api.baseUrl;
        api.setBaseUrl(url);
        try {
          person = await api.redeem(code);
        } catch (err) {
          api.setBaseUrl(previous);
          throw err;
        }
        settings.setServerUrl(url);
        return person;
      }
      person = await api.redeem(code);
      return person;
    },
    async openExternal(url) {
      if (!/^https:\/\/[^\s]+$/.test(url)) throw new ApiError("Only secure links can be opened.", "invalid_url", 0);
      await openExternal(url);
    },
    async checkServer(raw): Promise<ServerCheck> {
      const url = normalizeServerUrl(raw);
      const none = { reachable: false, isCloneme: false, https: false, claimed: false, claimable: false, persistentStorage: false, publicBaseUrl: null };
      if (!url) return { ...none, message: "That address does not look right. It should look like https://your-name.onrender.com" };
      try {
        const res = await fetchImpl(`${url}/healthz`, { signal: AbortSignal.timeout(10000) });
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (!res.ok || !body || body.app !== "cloneme") {
          return { ...none, reachable: true, message: "Something answered, but it is not a cloneME server. Check the address you copied." };
        }
        // Plain http is accepted for a server on this same computer, used for local testing in mock mode.
        const https = url.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(url);
        return {
          reachable: true,
          isCloneme: true,
          https,
          claimed: Boolean(body.claimed),
          claimable: Boolean(body.claimable),
          persistentStorage: Boolean(body.persistentStorage),
          publicBaseUrl: typeof body.publicBaseUrl === "string" ? body.publicBaseUrl : null,
          message: https ? "Your server is online." : "Your server is online, but it needs a secure https:// address.",
        };
      } catch {
        return { ...none, message: "Could not reach that address. A new Render server can take a few minutes to start; wait and check again." };
      }
    },
    async connectServer({ serverUrl, setupToken, ownerCode, ownerName }) {
      const url = normalizeServerUrl(serverUrl);
      if (!url) throw new ApiError("That server address does not look right.", "invalid_url", 0);
      const previous = api.baseUrl;
      api.setBaseUrl(url);
      let ownerCodeOut: string | undefined;
      try {
        if (setupToken) {
          const out = await api.request<{ token: string; inviteCode: string; person: Person }>("POST", "/api/setup/claim", {
            setupToken: setupToken.trim(),
            ownerName: ownerName?.trim() || "Owner",
          });
          api.adopt(out.token);
          person = out.person;
          ownerCodeOut = out.inviteCode;
        } else if (ownerCode) {
          person = await api.redeem(ownerCode);
          if (person.role !== "owner") {
            api.signOut();
            person = null;
            throw new ApiError("That code is for a friend, not the owner. Use your owner code.", "not_owner", 403);
          }
        } else {
          throw new ApiError("Enter the setup token from your server, or your owner code.", "invalid_body", 400);
        }
      } catch (err) {
        api.setBaseUrl(previous);
        throw err;
      }
      settings.setServerUrl(url);
      const local = settings.wizard;
      if (local.consentAccepted && local.consentName) {
        await owner("PUT", "/onboarding", { consentAccepted: true, consentName: local.consentName }).catch(() => undefined);
      }
      const keyResults = await flushStagedKeys().catch(() => ({}));
      return { person: person!, ownerCode: ownerCodeOut, keyResults };
    },
    async getLocalWizard() {
      return settings.wizard;
    },
    async saveLocalWizard(patch) {
      return settings.patchWizard(patch);
    },
    async submitKeys(keys) {
      if (api.signedIn) {
        try {
          const out = await api.request<{ results: Record<string, KeyResult> }>("PUT", "/api/owner/keys", keys);
          return { results: out.results, stagedOnly: false };
        } catch (err) {
          if (err instanceof ApiError && err.status === 422) return { results: (err.details as { results: Record<string, KeyResult> }).results, stagedOnly: false };
          throw err;
        }
      }
      return { results: await stage.stage(keys), stagedOnly: true };
    },
    async getKeysStatus(): Promise<KeysStatus> {
      const vendors = Object.fromEntries(
        VENDOR_NAMES.map((v) => [v, { saved: false, staged: stage.has(v), source: null, check: null, warning: stage.result(v)?.warning ?? null }]),
      ) as KeysStatus["vendors"];
      if (!api.signedIn) return { connected: false, mockMode: false, vendors, llm: stage.llm };
      const server = await owner<{
        mockMode: boolean;
        vendors: Record<VendorName, { configured: boolean; source: string | null; check: (KeyResult & { checkedAt: string }) | null }>;
        llm: { baseUrl: string; model: string };
      }>("GET", "/keys");
      for (const v of VENDOR_NAMES) {
        const s = server.vendors[v];
        vendors[v] = { saved: s.configured, staged: stage.has(v), source: s.source, check: s.check, warning: s.check?.warning ?? null };
      }
      return { connected: true, mockMode: server.mockMode, vendors, llm: server.llm };
    },
    async recheckKeys() {
      if (!api.signedIn) throw new ApiError("Connect your server first.", "unauthorized", 401);
      return owner<{ results: Record<string, KeyResult> }>("POST", "/keys/verify", {});
    },
    async getOnboarding(): Promise<OnboardingData | null> {
      if (!api.signedIn) return null;
      return owner<OnboardingData>("GET", "/onboarding");
    },
    async saveOnboarding(patch) {
      await owner("PUT", "/onboarding", patch);
    },
    uploadRecording: (rec) =>
      api.uploadBytes(rec.data, rec.filename, rec.mimeType, rec.purpose, { durationSec: rec.durationSec, promptId: rec.promptId, promptKind: rec.promptKind, quality: rec.quality }),
    async uploadExistingVoice() {
      const files = await pickFiles("voice");
      const uploaded = [];
      const failed: { name: string; message: string }[] = [];
      for (const file of files) {
        try {
          const d = mediaDuration(file);
          uploaded.push(await api.uploadFile(file, "voice", { durationSec: d.seconds, durationEstimated: d.estimated, promptKind: "free" }));
        } catch (err) {
          failed.push({ name: file.split(/[\\/]/).pop() ?? file, message: (err as Error).message });
        }
      }
      return { uploaded, failed };
    },
    getBuild: () => owner<BuildStatus>("GET", "/build"),
    startBuild: () => owner<BuildStatus>("POST", "/build/start", {}),
    confirmVoiceVerified: () => owner<BuildStatus>("POST", "/build/verified", {}),
    retryBuildStage: (stageId) => owner<BuildStatus>("POST", "/build/retry", { stage: stageId }),
    async signOut() {
      person = null;
      api.signOut();
    },
    startSession: () => api.startSession(),
    async endSession(id) {
      await api.endSession(id);
    },
    sendText: (id, text) => api.sendText(id, text),

    getProfile: () => owner("GET", "/profile"),
    saveProfile: (profile) => owner("PUT", "/profile", profile),
    getStyle: () => owner("GET", "/style"),
    getFacts: () => owner("GET", "/facts"),
    setFactStatus: (id, status) => owner("PATCH", `/facts/${encodeURIComponent(id)}`, { status }),
    listPeople: () => owner("GET", "/people"),
    addPerson: (input) => owner("POST", "/people", input),
    async revokePerson(id) {
      await owner("DELETE", `/people/${encodeURIComponent(id)}`);
    },
    newInviteCode: (id) => owner("POST", `/people/${encodeURIComponent(id)}/code`, {}),
    setPersonBanner: (id, aiBanner) => owner("PATCH", `/people/${encodeURIComponent(id)}`, { aiBanner }),
    async clearPersonMemory(id) {
      await owner("DELETE", `/people/${encodeURIComponent(id)}/memory`);
    },
    listMedia: () => owner("GET", "/media"),
    async pickAndUpload(purpose) {
      const files = await pickFiles(purpose);
      const uploaded = [];
      const failed: { name: string; message: string }[] = [];
      for (const file of files) {
        try {
          uploaded.push(await api.uploadFile(file, purpose));
        } catch (err) {
          failed.push({ name: file.split(/[\\/]/).pop() ?? file, message: (err as Error).message });
        }
      }
      return { uploaded, failed };
    },
    async deleteMedia(id) {
      await owner("DELETE", `/media/${encodeURIComponent(id)}`);
    },
    runTraining: (force) => owner<{ started: boolean }>("POST", "/training/run", { force: Boolean(force) }).catch((err) => {
      if (err?.status === 409) return { started: false };
      throw err;
    }),
    listJobs: () => owner("GET", "/training/jobs"),
    getVendors: (sync) => owner("GET", `/vendors${sync ? "?sync=1" : ""}`),
    setupVoice: () => owner("POST", "/vendors/voice", {}),
    trainVoice: () => owner("POST", "/vendors/voice/train", {}),
    setupReplica: () => owner("POST", "/vendors/replica", {}),
    setupPersona: () => owner("POST", "/vendors/persona", {}),
  };
  return handlers;
}
