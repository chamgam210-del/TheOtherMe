import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { VendorKeys } from "./config.js";

interface Envelope {
  v: 1;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

/**
 * Vendor keys the owner pasted into the app. They live only on the server, encrypted with a key derived from
 * SESSION_SECRET. Keep SESSION_SECRET in the host's secret store (separate from the disk) for this to add protection.
 */
export class SecretStore {
  private file: string | null;

  constructor(
    dataDir: string | null,
    private secret: string,
  ) {
    this.file = dataDir ? path.join(dataDir, "secrets.enc.json") : null;
  }

  private memory: VendorKeys = {};

  load(): VendorKeys {
    if (!this.file) return this.memory;
    if (!existsSync(this.file)) return {};
    try {
      const env = JSON.parse(readFileSync(this.file, "utf8")) as Envelope;
      const key = scryptSync(this.secret, Buffer.from(env.salt, "base64"), 32);
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
      decipher.setAuthTag(Buffer.from(env.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(env.data, "base64")), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as VendorKeys;
    } catch {
      console.error("secrets.enc.json could not be decrypted (SESSION_SECRET changed?). Re-enter your keys in the app.");
      return {};
    }
  }

  save(keys: VendorKeys): void {
    if (!this.file) {
      this.memory = keys;
      return;
    }
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", scryptSync(this.secret, salt, 32), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(keys), "utf8"), cipher.final()]);
    const env: Envelope = { v: 1, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  update(patch: (keys: VendorKeys) => VendorKeys): VendorKeys {
    const next = patch(this.load());
    this.save(next);
    return next;
  }
}
