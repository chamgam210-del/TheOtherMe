import type { StepId } from "../../shared/wizard.js";
import { aboutStep, avoidStep, inviteStep, uploadsStep } from "./stepsAbout.js";
import { buildStep, testStep } from "./stepsBuild.js";
import { consentStep, videoRecordStep, voiceStep } from "./stepsRecord.js";
import { keysStep, serverStep, welcomeStep } from "./stepsSetup.js";
import type { StepRenderer } from "./types.js";

export const STEP_RENDERERS: Record<StepId, StepRenderer> = {
  welcome: welcomeStep,
  keys: keysStep,
  server: serverStep,
  voice: voiceStep,
  video: videoRecordStep,
  consent: consentStep,
  uploads: uploadsStep,
  about: aboutStep,
  avoid: avoidStep,
  invite: inviteStep,
  build: buildStep,
  test: testStep,
};
