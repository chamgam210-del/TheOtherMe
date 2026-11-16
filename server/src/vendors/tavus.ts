import { randomUUID } from "node:crypto";
import { ensureOk, type FetchLike, type TavusClient } from "./types.js";

const BASE = "https://tavusapi.com/v2";

/** Tavus CVI: https://docs.tavus.io — conversations, personas (custom LLM + TTS layers) and replicas. */
export class RealTavus implements TavusClient {
  readonly mock = false;
  constructor(
    private apiKey: string,
    private fetchImpl: FetchLike = fetch,
    private base = BASE,
  ) {}

  private async call(method: string, path: string, body?: unknown) {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { "x-api-key": this.apiKey, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await ensureOk("tavus", res);
    const text = await res.text();
    return text ? (JSON.parse(text) as Record<string, any>) : {};
  }

  async createConversation(input: Parameters<TavusClient["createConversation"]>[0]) {
    const json = await this.call("POST", "/conversations", {
      replica_id: input.replicaId,
      persona_id: input.personaId,
      conversation_name: input.conversationName,
      conversational_context: input.conversationalContext,
      custom_greeting: input.customGreeting,
      callback_url: input.callbackUrl,
      memory_stores: [input.participantTag],
      properties: {
        max_call_duration: input.maxCallSeconds,
        participant_left_timeout: 15,
        participant_absent_timeout: 60,
        enable_recording: false,
      },
    });
    return { conversationId: String(json.conversation_id), conversationUrl: String(json.conversation_url) };
  }

  async endConversation(conversationId: string) {
    await this.call("POST", `/conversations/${encodeURIComponent(conversationId)}/end`);
  }

  async createPersona(input: Parameters<TavusClient["createPersona"]>[0]) {
    const json = await this.call("POST", "/personas", {
      persona_name: input.name,
      system_prompt: input.systemPrompt,
      pipeline_mode: "full",
      default_replica_id: input.replicaId,
      layers: {
        llm: {
          model: input.llmModel,
          base_url: input.llmBaseUrl,
          api_key: input.llmApiKey,
          speculative_inference: true,
        },
        tts: {
          tts_engine: "elevenlabs",
          external_voice_id: input.elevenLabsVoiceId,
          api_key: input.elevenLabsApiKey,
          tts_model_name: "eleven_flash_v2_5",
        },
      },
    });
    return { personaId: String(json.persona_id) };
  }

  async createReplica(input: Parameters<TavusClient["createReplica"]>[0]) {
    const json = await this.call("POST", "/replicas", {
      replica_name: input.name,
      model_name: "phoenix-3",
      train_video_url: input.trainVideoUrl,
      consent_video_url: input.consentVideoUrl,
      callback_url: input.callbackUrl,
    });
    return { replicaId: String(json.replica_id), status: String(json.status ?? "started") };
  }

  async getReplica(replicaId: string) {
    const json = await this.call("GET", `/replicas/${encodeURIComponent(replicaId)}`);
    return { status: String(json.status ?? "unknown") };
  }
}

export class MockTavus implements TavusClient {
  readonly mock = true;
  readonly ended: string[] = [];

  async createConversation() {
    const id = `mock_${randomUUID().slice(0, 8)}`;
    return { conversationId: id, conversationUrl: `mock://conversation/${id}` };
  }

  async endConversation(conversationId: string) {
    this.ended.push(conversationId);
  }

  async createPersona() {
    return { personaId: `mock_persona_${randomUUID().slice(0, 6)}` };
  }

  async createReplica() {
    return { replicaId: `mock_replica_${randomUUID().slice(0, 6)}`, status: "started" };
  }

  async getReplica() {
    return { status: "completed" };
  }
}
