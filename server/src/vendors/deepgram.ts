import { openAsBlob, readFileSync } from "node:fs";
import { ensureOk, type DeepgramClient, type FetchLike, type TranscriptResult, type UploadFile } from "./types.js";

const BASE = "https://api.deepgram.com/v1";

/** Deepgram Nova-3 pre-recorded transcription with word timestamps and speaker diarization. */
export class RealDeepgram implements DeepgramClient {
  readonly mock = false;
  constructor(
    private apiKey: string,
    private fetchImpl: FetchLike = fetch,
    private base = BASE,
  ) {}

  async transcribe(file: UploadFile & { mimeType: string }): Promise<TranscriptResult> {
    const params = new URLSearchParams({
      model: "nova-3",
      diarize: "true",
      utterances: "true",
      smart_format: "true",
      punctuate: "true",
      language: "en",
    });
    const res = await this.fetchImpl(`${this.base}/listen?${params}`, {
      method: "POST",
      headers: { authorization: `Token ${this.apiKey}`, "content-type": file.mimeType || "application/octet-stream" },
      body: await openAsBlob(file.path),
    });
    await ensureOk("deepgram", res);
    return parseDeepgram(await res.json());
  }
}

export function parseDeepgram(json: any): TranscriptResult {
  const alt = json?.results?.channels?.[0]?.alternatives?.[0];
  let utterances: TranscriptResult["utterances"] = (json?.results?.utterances ?? []).map((u: any) => ({
    speaker: Number(u.speaker ?? 0),
    start: Number(u.start ?? 0),
    end: Number(u.end ?? 0),
    text: String(u.transcript ?? ""),
  }));
  if (utterances.length === 0 && alt?.words?.length) {
    utterances = [];
    for (const w of alt.words as any[]) {
      const speaker = Number(w.speaker ?? 0);
      const last = utterances[utterances.length - 1];
      const word = String(w.punctuated_word ?? w.word);
      if (last && last.speaker === speaker) {
        last.text += ` ${word}`;
        last.end = Number(w.end);
      } else {
        utterances.push({ speaker, start: Number(w.start), end: Number(w.end), text: word });
      }
    }
  }
  return { text: String(alt?.transcript ?? utterances.map((u) => u.text).join(" ")), utterances };
}

/**
 * Offline stand-in. Files that contain plain text are treated as the transcript
 * ("Speaker 1: ..." prefixes pick the speaker), anything else gets a placeholder.
 */
export class MockDeepgram implements DeepgramClient {
  readonly mock = true;

  async transcribe(file: UploadFile & { mimeType: string }): Promise<TranscriptResult> {
    const buf = readFileSync(file.path).subarray(0, 256 * 1024);
    const printable = buf.length > 0 && !buf.includes(0);
    if (!printable) {
      const text = `[mock transcript of ${file.filename}]`;
      return { text, utterances: [{ speaker: 0, start: 0, end: 1, text }] };
    }
    const utterances: TranscriptResult["utterances"] = [];
    let t = 0;
    for (const line of buf.toString("utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = /^speaker\s*(\d+)\s*:\s*(.*)$/i.exec(trimmed);
      const speaker = m ? Number(m[1]) : 0;
      const text = m ? m[2]! : trimmed;
      const dur = Math.max(1, text.split(/\s+/).length * 0.4);
      utterances.push({ speaker, start: t, end: t + dur, text });
      t += dur;
    }
    return { text: utterances.map((u) => u.text).join(" "), utterances };
  }
}
