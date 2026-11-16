import { contextBridge, ipcRenderer } from "electron";
import { BRIDGE_METHODS, BridgeError, type RendererBridge, type UpdateStatus } from "./shared/bridge.js";

const bridge: Record<string, unknown> = {};
for (const method of BRIDGE_METHODS) {
  bridge[method] = async (...args: unknown[]) => {
    const res = await ipcRenderer.invoke(`cloneme:${method}`, ...args);
    if (!res.ok) throw new BridgeError(res.error.message, res.error.code, res.error.status);
    return res.value;
  };
}
bridge.onUpdate = (listener: (s: UpdateStatus) => void) => ipcRenderer.on("cloneme:update", (_e, s) => listener(s));
bridge.onSignedOut = (listener: (reason: string) => void) => ipcRenderer.on("cloneme:signedOut", (_e, r) => listener(r));
bridge.installUpdate = () => ipcRenderer.invoke("cloneme:installUpdate");

contextBridge.exposeInMainWorld("cloneme", bridge as unknown as RendererBridge);
