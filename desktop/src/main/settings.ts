import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LocalWizard } from "../shared/bridge.js";

interface SettingsShape {
  serverUrl?: string;
  wizard: LocalWizard;
}

/** Non-secret app settings (chosen server, wizard progress before a server exists). */
export class Settings {
  private file: string;
  private data: SettingsShape;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "settings.json");
    try {
      this.data = { wizard: {}, ...(JSON.parse(readFileSync(this.file, "utf8")) as Partial<SettingsShape>) };
    } catch {
      this.data = { wizard: {} };
    }
  }

  get serverUrl() {
    return this.data.serverUrl;
  }

  setServerUrl(url: string | undefined) {
    this.data.serverUrl = url;
    this.save();
  }

  get wizard(): LocalWizard {
    return this.data.wizard;
  }

  patchWizard(patch: LocalWizard): LocalWizard {
    this.data.wizard = { ...this.data.wizard, ...patch };
    this.save();
    return this.data.wizard;
  }

  private save() {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
