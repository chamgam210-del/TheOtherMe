import type { Bridge, MediaPurpose, Person } from "../shared/bridge.js";
import { ApiClient } from "./api.js";

export interface HandlerDeps {
  api: ApiClient;
  version: string;
  /** Shows the native multi-file picker; returns chosen absolute paths. */
  pickFiles(purpose: MediaPurpose): Promise<string[]>;
}

export function createHandlers({ api, version, pickFiles }: HandlerDeps): Bridge {
  let person: Person | null = null;
  const owner = <T>(method: string, route: string, body?: unknown) => api.request<T>(method, `/api/owner${route}`, body);

  const handlers: Bridge = {
    async getState() {
      if (api.signedIn && !person) {
        person = (await api.me().catch(() => null))?.person ?? null;
      }
      return { apiBaseUrl: api.baseUrl, person: api.signedIn ? person : null, version };
    },
    async signIn(code) {
      person = await api.redeem(code);
      return person;
    },
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
