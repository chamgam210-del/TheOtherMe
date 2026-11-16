import type { KeysStatus, LocalWizard, OnboardingData, RendererBridge, ServerCheck } from "../../shared/bridge.js";
import type { WizardFacts } from "../../shared/wizard.js";
import type { Recorders } from "../media.js";

export interface StepCtx {
  bridge: RendererBridge;
  recorders: Recorders;
  say(message: string, kind?: "error" | "info"): void;
  facts(): WizardFacts;
  data(): OnboardingData | null;
  keys(): KeysStatus | null;
  local(): LocalWizard;
  /** The server address the app is pointed at, if the owner has chosen one. */
  serverUrl(): string;
  ownerName(): string;
  /** Re-reads everything from the app and refreshes the stepper and footer (the step body is left alone). */
  refresh(): Promise<void>;
  /** The consent checkbox and name as typed, before they are saved. */
  draftConsent(consent: { accepted: boolean; name: string }): void;
  /** The result of the latest server check for the address being tried. */
  setServerCheck(check: ServerCheck | null, url?: string): void;
  /** Re-validates the footer after on-screen changes. */
  invalidate(): void;
  onCleanup(fn: () => void): void;
  startTestCall(): Promise<void>;
  pollMs: number;
}

export type StepRenderer = (el: HTMLElement, ctx: StepCtx) => void | Promise<void>;
