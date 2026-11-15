import Daily from "@daily-co/daily-js";

export type CallState = "connecting" | "live" | "ended" | "error";

export interface CallElements {
  remoteVideo: HTMLVideoElement;
  remoteAudio: HTMLAudioElement;
  localVideo: HTMLVideoElement;
}

export interface CallHandle {
  setMuted(muted: boolean): void;
  setCameraOff(off: boolean): void;
  leave(): Promise<void>;
}

export interface CallRequest {
  url: string;
  mock: boolean;
  elements: CallElements;
  onState(state: CallState, message?: string): void;
}

export type CreateCall = (req: CallRequest) => Promise<CallHandle>;

const stream = (track: MediaStreamTrack) => new MediaStream([track]);

/** Live call: the Tavus conversation URL is a Daily room, so the Daily call object carries WebRTC audio and video. */
async function createDailyCall(req: CallRequest): Promise<CallHandle> {
  const call = Daily.createCallObject({ audioSource: true, videoSource: true, subscribeToTracksAutomatically: true });
  call.on("track-started", (ev) => {
    if (!ev?.track || !ev.participant) return;
    if (ev.participant.local) {
      if (ev.track.kind === "video") req.elements.localVideo.srcObject = stream(ev.track);
    } else if (ev.track.kind === "video") {
      req.elements.remoteVideo.srcObject = stream(ev.track);
      req.onState("live");
    } else if (ev.track.kind === "audio") {
      req.elements.remoteAudio.srcObject = stream(ev.track);
    }
  });
  call.on("participant-left", (ev) => {
    if (ev && !ev.participant.local) req.onState("ended");
  });
  call.on("left-meeting", () => req.onState("ended"));
  call.on("error", (ev) => req.onState("error", ev?.errorMsg ?? "The call hit an error."));
  call.on("camera-error", () => req.onState("error", "Could not use your camera or microphone. Check Windows privacy settings."));
  await call.join({ url: req.url });
  return {
    setMuted: (muted) => void call.setLocalAudio(!muted),
    setCameraOff: (off) => void call.setLocalVideo(!off),
    async leave() {
      await call.leave().catch(() => undefined);
      call.destroy();
    },
  };
}

/** Mock mode: only local camera and microphone preview; the "AI" is a placeholder and replies come through text. */
async function createMockCall(req: CallRequest): Promise<CallHandle> {
  let media: MediaStream | null = null;
  try {
    media = await navigator.mediaDevices?.getUserMedia?.({ audio: true, video: true });
  } catch {
    try {
      media = await navigator.mediaDevices?.getUserMedia?.({ audio: true });
    } catch {
      media = null;
    }
  }
  if (media) req.elements.localVideo.srcObject = media;
  req.onState("live");
  return {
    setMuted: (muted) => media?.getAudioTracks().forEach((t) => (t.enabled = !muted)),
    setCameraOff: (off) => media?.getVideoTracks().forEach((t) => (t.enabled = !off)),
    async leave() {
      media?.getTracks().forEach((t) => t.stop());
      req.onState("ended");
    },
  };
}

export const createCall: CreateCall = (req) => (req.mock || req.url.startsWith("mock://") ? createMockCall(req) : createDailyCall(req));
