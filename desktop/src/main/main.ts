import { readFileSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { BRIDGE_METHODS, type MediaPurpose, type UpdateStatus } from "../shared/bridge.js";
import { ApiClient, ApiError } from "./api.js";
import { createHandlers } from "./handlers.js";
import { FileTokenStore } from "./tokenStore.js";

const DEFAULT_API_URL = (() => {
  try {
    return (JSON.parse(readFileSync(path.join(__dirname, "config.json"), "utf8")) as { apiBaseUrl: string }).apiBaseUrl;
  } catch {
    return "http://localhost:8787";
  }
})();

let win: BrowserWindow | null = null;

const send = (channel: string, payload: unknown) => win?.webContents.send(channel, payload);

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: "#0f1115",
    title: "cloneME",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  void win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function lockDownPermissions() {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const own = details.requestingUrl.startsWith("file://");
    callback(own && (permission === "media" || permission === "fullscreen"));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => origin.startsWith("file://") && permission === "media");
}

function setupUpdater() {
  const push = (status: UpdateStatus) => send("cloneme:update", status);
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => push({ state: "checking" }));
  autoUpdater.on("update-available", (i) => push({ state: "available", version: i.version }));
  autoUpdater.on("update-not-available", () => push({ state: "none" }));
  autoUpdater.on("download-progress", (p) => push({ state: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (i) => push({ state: "ready", version: i.version }));
  autoUpdater.on("error", (e) => push({ state: "error", message: e.message }));
  ipcMain.handle("cloneme:installUpdate", () => autoUpdater.quitAndInstall());
  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined);
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
}

app.whenReady().then(() => {
  const apiBaseUrl = process.env.CLONEME_API_URL || DEFAULT_API_URL;
  const tokens = new FileTokenStore(app.getPath("userData"), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  });
  const api = new ApiClient(apiBaseUrl, tokens, () => send("cloneme:signedOut", "Your access has ended."));
  const handlers = createHandlers({
    api,
    version: app.getVersion(),
    pickFiles: async (purpose: MediaPurpose) => {
      const filters =
        purpose === "voice" ? [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "flac", "ogg"] }]
        : purpose === "replica" || purpose === "consent" ? [{ name: "Video", extensions: ["mp4", "mov", "webm", "mkv"] }]
        : [{ name: "Media and text", extensions: ["wav", "mp3", "m4a", "flac", "ogg", "mp4", "mov", "webm", "mkv", "jpg", "jpeg", "png", "txt", "md", "json"] }];
      const result = await dialog.showOpenDialog(win!, {
        properties: purpose === "replica" || purpose === "consent" ? ["openFile"] : ["openFile", "multiSelections"],
        filters,
      });
      return result.canceled ? [] : result.filePaths;
    },
  });

  for (const method of BRIDGE_METHODS) {
    ipcMain.handle(`cloneme:${method}`, async (_event, ...args: unknown[]) => {
      try {
        return { ok: true, value: await (handlers[method] as (...a: unknown[]) => Promise<unknown>)(...args) };
      } catch (err) {
        const e = err as ApiError;
        return { ok: false, error: { message: e.message, code: e instanceof ApiError ? e.code : "error", status: e instanceof ApiError ? e.status : 0 } };
      }
    });
  }

  lockDownPermissions();
  createWindow();
  if (app.isPackaged) setupUpdater();
});

app.on("window-all-closed", () => app.quit());
