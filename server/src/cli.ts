import { copyFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { addPerson, ensureOwner } from "./auth.js";
import { loadConfig } from "./config.js";
import { inferKind, mediaDirOf } from "./media.js";
import { formatReport, measureLatency } from "./scripts/measureLatency.js";
import { SetupError, setupPersona, setupReplica, setupVoice, syncVendorStatus, trainVoice, vendorStatus } from "./setup.js";
import { newId, Store, type MediaItem } from "./store.js";
import { createVendors } from "./vendors/index.js";

const [command, ...rest] = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!;
  if (a.startsWith("--")) {
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(a.slice(2), next);
      i++;
    } else flags.set(a.slice(2), "true");
  } else positional.push(a);
}

const USAGE = `cloneME admin CLI (run where the server's DATA_DIR and env are available)

  add-media <file> --purpose voice|replica|consent|training   copy a local file into the media library
  add-person <name> --role family|friend [--relationship mom]   create an invite code
  setup-voice [--train]       create the ElevenLabs PVC from voice media (or --train to start training)
  setup-replica               create the Tavus replica from replica + consent videos
  setup-persona               create the Tavus persona (persona service as LLM, ElevenLabs voice)
  status [--sync]             show vendor modes and ids
  measure-latency [--url U --code INVITE --runs N --persona-secret S --json]`;

async function main() {
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  if (command === "measure-latency") {
    const report = await measureLatency({
      url: flags.get("url"),
      code: flags.get("code"),
      personaSecret: flags.get("persona-secret"),
      runs: Number(flags.get("runs") ?? 10),
      json: flags.has("json"),
    });
    console.log(flags.has("json") ? JSON.stringify(report, null, 2) : formatReport(report));
    return;
  }

  const config = loadConfig();
  const store = new Store(config.dataDir, config.ownerName);
  ensureOwner(store, config);
  const deps = { config, store, vendors: createVendors(config) };

  switch (command) {
    case "add-media": {
      const file = positional[0];
      if (!file) throw new Error("usage: add-media <file> --purpose ...");
      const purpose = (flags.get("purpose") ?? "training") as MediaItem["purpose"];
      const filename = path.basename(file);
      const kind = inferKind(filename, "");
      if (!kind) throw new Error(`unsupported file type: ${filename}`);
      const id = newId("med");
      const storedAs = `${id}${path.extname(filename).toLowerCase()}`;
      mkdirSync(mediaDirOf(config), { recursive: true });
      copyFileSync(file, path.join(mediaDirOf(config), storedAs));
      store.update((db) =>
        db.media.push({
          id, kind, filename, storedAs, bytes: statSync(file).size, mimeType: "application/octet-stream",
          purpose, createdAt: new Date().toISOString(),
        }),
      );
      console.log(`added ${filename} as ${id} (${kind}, ${purpose})`);
      break;
    }
    case "add-person": {
      const name = positional[0];
      if (!name) throw new Error("usage: add-person <name> --role family|friend");
      const role = flags.get("role") === "family" ? "family" : "friend";
      const { person, code } = addPerson(store, { name, role, relationship: flags.get("relationship") });
      console.log(`${person.name} (${person.role}) invite code: ${code}`);
      break;
    }
    case "setup-voice":
      console.log(JSON.stringify(flags.has("train") ? await trainVoice(deps) : await setupVoice(deps), null, 2));
      break;
    case "setup-replica":
      console.log(JSON.stringify(await setupReplica(deps), null, 2));
      break;
    case "setup-persona":
      console.log(JSON.stringify(await setupPersona(deps), null, 2));
      break;
    case "status":
      console.log(JSON.stringify(flags.has("sync") ? await syncVendorStatus(deps) : vendorStatus(deps), null, 2));
      break;
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof SetupError ? `${err.code}: ${err.message}` : (err as Error).message);
  process.exit(1);
});
