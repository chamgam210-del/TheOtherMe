export type FetchLike = typeof fetch;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmClient {
  readonly mock: boolean;
  /** Streams text deltas. */
  stream(messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }): AsyncIterable<string>;
  complete(messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number; json?: boolean }): Promise<string>;
}

export interface TavusConversationInput {
  replicaId: string;
  personaId: string;
  conversationName: string;
  conversationalContext: string;
  customGreeting: string;
  participantTag: string;
  maxCallSeconds: number;
  callbackUrl?: string;
}

export interface TavusClient {
  readonly mock: boolean;
  createConversation(input: TavusConversationInput): Promise<{ conversationId: string; conversationUrl: string }>;
  endConversation(conversationId: string): Promise<void>;
  createPersona(input: {
    name: string;
    systemPrompt: string;
    replicaId: string;
    llmBaseUrl: string;
    llmApiKey: string;
    llmModel: string;
    elevenLabsVoiceId: string;
    elevenLabsApiKey: string;
  }): Promise<{ personaId: string }>;
  createReplica(input: {
    name: string;
    trainVideoUrl: string;
    consentVideoUrl: string;
    callbackUrl?: string;
  }): Promise<{ replicaId: string; status: string }>;
  getReplica(replicaId: string): Promise<{ status: string }>;
}

export interface UploadFile {
  path: string;
  filename: string;
}

export interface ElevenLabsClient {
  readonly mock: boolean;
  createPvcVoice(input: { name: string; description?: string; language?: string }): Promise<{ voiceId: string }>;
  addPvcSamples(voiceId: string, files: UploadFile[]): Promise<{ sampleIds: string[] }>;
  requestPvcVerification(voiceId: string, files: UploadFile[], note?: string): Promise<void>;
  startPvcTraining(voiceId: string, modelId?: string): Promise<void>;
  getVoiceStatus(voiceId: string): Promise<{ status: "created" | "needs_verification" | "training" | "ready" | "error"; raw?: unknown }>;
  ttsFirstByteMs(voiceId: string, text: string): Promise<number>;
}

export interface TranscriptResult {
  text: string;
  utterances: { speaker: number; start: number; end: number; text: string }[];
}

export interface DeepgramClient {
  readonly mock: boolean;
  transcribe(file: UploadFile & { mimeType: string }): Promise<TranscriptResult>;
}

export interface Vendors {
  tavus: TavusClient;
  elevenlabs: ElevenLabsClient;
  deepgram: DeepgramClient;
  llm: LlmClient;
}

export class VendorError extends Error {
  constructor(
    public vendor: string,
    public status: number,
    message: string,
  ) {
    super(`${vendor} ${status}: ${message}`);
  }
}

export async function ensureOk(vendor: string, res: Response): Promise<Response> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new VendorError(vendor, res.status, text.slice(0, 500));
  }
  return res;
}
