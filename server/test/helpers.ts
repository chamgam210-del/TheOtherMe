import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp, type AppContext } from "../src/app.js";
import { addPerson } from "../src/auth.js";
import { loadConfig, type Config } from "../src/config.js";
import { Store } from "../src/store.js";
import { MockDeepgram } from "../src/vendors/deepgram.js";
import { MockElevenLabs } from "../src/vendors/elevenlabs.js";
import { MockTavus } from "../src/vendors/tavus.js";
import type { ChatMessage, LlmClient, TavusConversationInput, Vendors } from "../src/vendors/types.js";

export const OWNER_CODE = "OWNR-TEST-CODE";

/** LLM double that records prompts and replies with a scripted function. */
export class RecordingLlm implements LlmClient {
  readonly mock = true;
  calls: ChatMessage[][] = [];
  constructor(private script: (messages: ChatMessage[]) => string = () => "Sounds good. Tell me more.") {}
  async *stream(messages: ChatMessage[]) {
    this.calls.push(messages);
    for (const part of this.script(messages).split(/(?<=\s)/)) yield part;
  }
  async complete(messages: ChatMessage[]) {
    this.calls.push(messages);
    return this.script(messages);
  }
}

export class RecordingTavus extends MockTavus {
  conversations: TavusConversationInput[] = [];
  override async createConversation(input?: TavusConversationInput) {
    if (input) this.conversations.push(input);
    return super.createConversation();
  }
}

export function makeCtx(env: Record<string, string> = {}, vendorOverrides: Partial<Vendors> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "cloneme-"));
  const config: Config = loadConfig({
    MOCK_MODE: "true",
    DATA_DIR: dir,
    OWNER_NAME: "Sam Rivera",
    OWNER_INVITE_CODE: OWNER_CODE,
    SESSION_SECRET: "test-secret-test-secret-test-secret-1234",
    PERSONA_LLM_SHARED_SECRET: "persona-secret-persona-secret",
    PUBLIC_BASE_URL: "https://api.example.test",
    ...env,
  });
  const store = new Store(dir, config.ownerName);
  const vendors: Vendors = {
    tavus: new RecordingTavus(),
    elevenlabs: new MockElevenLabs(),
    deepgram: new MockDeepgram(),
    llm: new RecordingLlm(),
    ...vendorOverrides,
  };
  const ctx: AppContext = createApp({ config, store, vendors });
  return { ...ctx, dir, tavus: vendors.tavus as RecordingTavus, llm: vendors.llm as RecordingLlm, api: request(ctx.app) };
}

export type TestCtx = ReturnType<typeof makeCtx>;

export async function login(ctx: TestCtx, code: string) {
  const res = await ctx.api.post("/api/auth/redeem").send({ code });
  return res.body.token as string;
}

export const ownerToken = (ctx: TestCtx) => login(ctx, OWNER_CODE);

export async function invite(ctx: TestCtx, name: string, role: "family" | "friend" = "friend", relationship?: string) {
  const { person, code } = addPerson(ctx.store, { name, role, relationship });
  return { person, code, token: await login(ctx, code) };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
