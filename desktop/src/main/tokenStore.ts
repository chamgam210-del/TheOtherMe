import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TokenStore } from "./api.js";

export interface Crypto {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

/** Keeps the sign-in token on disk, encrypted with the OS keychain (DPAPI on Windows). */
export class FileTokenStore implements TokenStore {
  private cache: string | null | undefined;
  private file: string;

  constructor(
    dir: string,
    private crypto: Crypto,
  ) {
    this.file = path.join(dir, "session.bin");
    mkdirSync(dir, { recursive: true });
  }

  get(): string | null {
    if (this.cache !== undefined) return this.cache;
    this.cache = null;
    if (this.crypto.available() && existsSync(this.file)) {
      try {
        this.cache = this.crypto.decrypt(readFileSync(this.file));
      } catch {
        rmSync(this.file, { force: true });
      }
    }
    return this.cache;
  }

  set(token: string | null): void {
    this.cache = token;
    if (token === null) {
      rmSync(this.file, { force: true });
    } else if (this.crypto.available()) {
      writeFileSync(this.file, this.crypto.encrypt(token), { mode: 0o600 });
    }
  }
}
