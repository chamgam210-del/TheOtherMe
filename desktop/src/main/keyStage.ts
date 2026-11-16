import { verifyVendorKey, type KeyVerification, type VendorId } from "../../../server/src/vendors/verify.js";
import type { KeyResult, KeysInput } from "../shared/bridge.js";

interface Staged {
  key: string;
  result: KeyResult;
}

const DEFAULT_LLM = { baseUrl: "https://api.openai.com/v1", model: "gpt-4o" };

/**
 * Before the owner's server exists there is nowhere safe to keep keys, so they are tested right away and held only in
 * this process's memory (never on disk). They are sent to the server the moment it is connected and then forgotten.
 */
export class KeyStage {
  private staged = new Map<VendorId, Staged>();
  private llmConfig = { ...DEFAULT_LLM };

  constructor(private fetchImpl: typeof fetch = fetch) {}

  async stage(input: KeysInput): Promise<Record<string, KeyVerification>> {
    const results: Record<string, KeyVerification> = {};
    const jobs: Promise<void>[] = [];
    if (input.llm?.baseUrl || input.llm?.model) {
      this.llmConfig = { baseUrl: input.llm.baseUrl ?? this.llmConfig.baseUrl, model: input.llm.model ?? this.llmConfig.model };
    }
    for (const vendor of ["tavus", "elevenlabs", "deepgram"] as const) {
      const key = input[vendor]?.trim();
      if (key) jobs.push(this.test(vendor, key, results));
    }
    if (input.llm?.apiKey?.trim()) jobs.push(this.test("llm", input.llm.apiKey.trim(), results));
    await Promise.all(jobs);
    return results;
  }

  private async test(vendor: VendorId, key: string, results: Record<string, KeyVerification>) {
    const result = /\s/.test(key) ? { ok: false, message: "Keys cannot contain spaces." } : await verifyVendorKey(vendor, this.fetchImpl, key, this.llmConfig);
    results[vendor] = result;
    if (result.ok) this.staged.set(vendor, { key, result });
  }

  has(vendor: VendorId) {
    return this.staged.has(vendor);
  }

  result(vendor: VendorId) {
    return this.staged.get(vendor)?.result ?? null;
  }

  /** Hands over everything staged for upload to the server. */
  take(): KeysInput | null {
    if (!this.staged.size) return null;
    const out: KeysInput = {};
    for (const [vendor, { key }] of this.staged) {
      if (vendor === "llm") out.llm = { apiKey: key, ...this.llmConfig };
      else out[vendor] = key;
    }
    return out;
  }

  clear(vendors?: VendorId[]) {
    if (!vendors) this.staged.clear();
    else for (const v of vendors) this.staged.delete(v);
  }

  get llm() {
    return this.llmConfig;
  }
}
