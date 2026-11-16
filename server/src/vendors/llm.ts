import { ensureOk, type ChatMessage, type FetchLike, type LlmClient } from "./types.js";

/** Any OpenAI-compatible chat completions provider (OpenAI, Azure proxy, vLLM, OpenRouter...). */
export class OpenAiCompatibleLlm implements LlmClient {
  readonly mock = false;
  constructor(
    private apiKey: string,
    private baseUrl: string,
    private model: string,
    private fetchImpl: FetchLike = fetch,
  ) {}

  private request(messages: ChatMessage[], stream: boolean, opts: { temperature?: number; maxTokens?: number; json?: boolean }) {
    return this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream,
        temperature: opts.temperature ?? 0.8,
        max_tokens: opts.maxTokens ?? 300,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
  }

  async *stream(messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number } = {}) {
    const res = await ensureOk("llm", await this.request(messages, true, opts));
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) yield delta as string;
        } catch {
          /* ignore keep-alive or partial lines */
        }
      }
    }
  }

  async complete(messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number; json?: boolean } = {}) {
    const res = await ensureOk("llm", await this.request(messages, false, { maxTokens: 1200, ...opts }));
    const json = (await res.json()) as any;
    return String(json.choices?.[0]?.message?.content ?? "");
  }
}

/** Deterministic, offline replies so the whole stack runs without a key. */
export class MockLlm implements LlmClient {
  readonly mock = true;

  private reply(messages: ChatMessage[]): string {
    const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const trimmed = last.trim().replace(/\s+/g, " ").slice(0, 120);
    if (!trimmed) return "Hey! Good to see you. What's up?";
    return `Ha, okay. You said "${trimmed}". Tell me more about that.`;
  }

  async *stream(messages: ChatMessage[]) {
    for (const word of this.reply(messages).split(/(?<=\s)/)) yield word;
  }

  async complete(messages: ChatMessage[], opts: { json?: boolean } = {}) {
    return opts.json ? "{}" : this.reply(messages);
  }
}
