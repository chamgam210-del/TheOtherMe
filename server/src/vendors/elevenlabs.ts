import { randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { ensureOk, type ElevenLabsClient, type FetchLike, type UploadFile } from "./types.js";

const BASE = "https://api.elevenlabs.io/v1";

async function filesForm(files: UploadFile[]) {
  const form = new FormData();
  for (const f of files) form.append("files", await openAsBlob(f.path), f.filename);
  return form;
}

/** ElevenLabs Professional Voice Clone (PVC) workflow. */
export class RealElevenLabs implements ElevenLabsClient {
  readonly mock = false;
  constructor(
    private apiKey: string,
    private fetchImpl: FetchLike = fetch,
    private base = BASE,
  ) {}

  private async call(method: string, path: string, body?: BodyInit, json = false) {
    const headers: Record<string, string> = { "xi-api-key": this.apiKey };
    if (json) headers["content-type"] = "application/json";
    const res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body });
    await ensureOk("elevenlabs", res);
    const text = await res.text();
    return text ? (JSON.parse(text) as Record<string, any>) : {};
  }

  async createPvcVoice(input: { name: string; description?: string; language?: string }) {
    const json = await this.call(
      "POST",
      "/voices/pvc",
      JSON.stringify({ name: input.name, description: input.description, language: input.language ?? "en" }),
      true,
    );
    return { voiceId: String(json.voice_id) };
  }

  async addPvcSamples(voiceId: string, files: UploadFile[]) {
    const json = await this.call("POST", `/voices/pvc/${voiceId}/samples`, await filesForm(files));
    const list = Array.isArray(json) ? json : [];
    return { sampleIds: (list as any[]).map((s) => String(s.sample_id)) };
  }

  async requestPvcVerification(voiceId: string, files: UploadFile[], note?: string) {
    const form = await filesForm(files);
    if (note) form.append("extra_text", note);
    await this.call("POST", `/voices/pvc/${voiceId}/verification`, form);
  }

  async startPvcTraining(voiceId: string, modelId = "eleven_multilingual_v2") {
    await this.call("POST", `/voices/pvc/${voiceId}/train`, JSON.stringify({ model_id: modelId }), true);
  }

  async getVoiceStatus(voiceId: string) {
    const json = await this.call("GET", `/voices/${voiceId}`);
    const states = Object.values((json.fine_tuning?.state ?? {}) as Record<string, string>);
    let status: "created" | "needs_verification" | "training" | "ready" | "error" = "created";
    if (states.includes("fine_tuned")) status = "ready";
    else if (states.includes("fine_tuning") || states.includes("queued")) status = "training";
    else if (states.includes("failed")) status = "error";
    else if (json.fine_tuning && json.fine_tuning.is_allowed_to_fine_tune === false) status = "needs_verification";
    return { status, raw: json.fine_tuning };
  }

  async ttsFirstByteMs(voiceId: string, text: string) {
    const start = performance.now();
    const res = await this.fetchImpl(`${this.base}/text-to-speech/${voiceId}/stream?output_format=mp3_22050_32`, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
    });
    await ensureOk("elevenlabs", res);
    const reader = res.body!.getReader();
    await reader.read();
    const ms = performance.now() - start;
    await reader.cancel();
    return ms;
  }
}

export class MockElevenLabs implements ElevenLabsClient {
  readonly mock = true;
  private trained = new Set<string>();

  async createPvcVoice() {
    return { voiceId: `mock_voice_${randomUUID().slice(0, 6)}` };
  }
  async addPvcSamples(_voiceId: string, files: UploadFile[]) {
    return { sampleIds: files.map((_, i) => `mock_sample_${i}`) };
  }
  async requestPvcVerification() {}
  async startPvcTraining(voiceId: string) {
    this.trained.add(voiceId);
  }
  async getVoiceStatus(voiceId: string) {
    return { status: this.trained.has(voiceId) ? ("ready" as const) : ("created" as const) };
  }
  async ttsFirstByteMs() {
    await new Promise((r) => setTimeout(r, 5));
    return 5;
  }
}
