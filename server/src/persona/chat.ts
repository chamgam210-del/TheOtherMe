import { randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Config } from "../config.js";
import type { Store } from "../store.js";
import type { ChatMessage, LlmClient } from "../vendors/types.js";
import { guardStream, topicMatcher } from "./guard.js";
import { getMemory, recordTurn } from "./memory.js";
import { buildSystemPrompt, PERSON_MARKER } from "./prompt.js";

const MAX_HISTORY = 24;

interface IncomingMessage {
  role: string;
  content: unknown;
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "object" && c && "text" in c ? String((c as any).text) : "")).join("");
  return "";
};

export interface PersonaDeps {
  config: Config;
  store: Store;
  llm: LlmClient;
}

/** Produces the reply for one user turn, as a guarded stream of text. Shared by the Tavus endpoint and the text fallback. */
export function personaReply(deps: PersonaDeps, personId: string | null, history: ChatMessage[]) {
  const { store, llm } = deps;
  const person = personId ? (store.data.people.find((p) => p.id === personId && !p.revoked) ?? null) : null;
  const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const { profile, style, facts } = store.data;
  const raised = topicMatcher(profile.avoidTopics)(lastUser);
  const system = buildSystemPrompt({
    profile,
    style,
    facts,
    person,
    memory: person ? getMemory(store, person.id) : null,
    raisedAvoidTopic: raised,
  });
  const messages: ChatMessage[] = [{ role: "system", content: system }, ...history.slice(-MAX_HISTORY)];
  const stream = guardStream(llm.stream(messages), profile.avoidTopics);
  return {
    person,
    stream,
    async finish(reply: string) {
      if (person && lastUser && reply.trim()) recordTurn(store, person.id, lastUser, reply.trim());
    },
  };
}

export async function collectReply(deps: PersonaDeps, personId: string | null, history: ChatMessage[]): Promise<string> {
  const r = personaReply(deps, personId, history);
  let text = "";
  for await (const part of r.stream) text += part;
  await r.finish(text);
  return text;
}

function bearerOk(req: Request, secret: string) {
  const header = req.header("authorization") ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
}

const chunk = (id: string, model: string, delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

/** OpenAI-compatible endpoint that Tavus calls as the persona's custom LLM. */
export function personaRouter(deps: PersonaDeps): Router {
  const router = Router();
  const MODEL = "cloneme-persona";

  router.use((req, res, next) => {
    if (!bearerOk(req, deps.config.personaSharedSecret)) {
      res.status(401).json({ error: { message: "invalid api key", type: "invalid_request_error" } });
      return;
    }
    next();
  });

  router.get("/models", (_req, res) => {
    res.json({ object: "list", data: [{ id: MODEL, object: "model", owned_by: "cloneme" }] });
  });

  router.post("/chat/completions", async (req: Request, res: Response) => {
    const incoming = (Array.isArray(req.body?.messages) ? req.body.messages : []) as IncomingMessage[];
    if (!incoming.length) {
      res.status(400).json({ error: { message: "messages required", type: "invalid_request_error" } });
      return;
    }
    let personId: string | null = null;
    const history: ChatMessage[] = [];
    for (const m of incoming) {
      const content = textOf(m.content);
      if (m.role === "system") {
        personId ??= PERSON_MARKER.exec(content)?.[1] ?? null;
      } else if (m.role === "user" || m.role === "assistant") {
        history.push({ role: m.role, content: content.replace(PERSON_MARKER, "").trim() });
      }
    }
    personId ??= req.header("x-cloneme-person") ?? null;

    const id = `chatcmpl-${randomUUID()}`;
    const model = typeof req.body.model === "string" ? req.body.model : MODEL;
    const reply = personaReply(deps, personId, history);
    let full = "";
    try {
      if (req.body.stream) {
        res.status(200).set({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(chunk(id, model, { role: "assistant", content: "" }));
        for await (const part of reply.stream) {
          full += part;
          res.write(chunk(id, model, { content: part }));
        }
        res.write(chunk(id, model, {}, "stop"));
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        for await (const part of reply.stream) full += part;
        res.json({
          id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: "assistant", content: full }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
      await reply.finish(full);
    } catch (err) {
      if (!res.headersSent) res.status(502).json({ error: { message: "upstream llm failure", type: "server_error" } });
      else res.end();
      console.error("persona chat failure:", (err as Error).message);
    }
  });

  return router;
}
