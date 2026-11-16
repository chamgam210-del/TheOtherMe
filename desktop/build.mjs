import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/renderer", { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: "info" };

await Promise.all([
  build({ ...common, entryPoints: ["src/main/main.ts"], outfile: "dist/main.cjs", platform: "node", format: "cjs", target: "node22", external: ["electron", "electron-updater"] }),
  build({ ...common, entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs", platform: "node", format: "cjs", target: "node22", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/renderer/main.ts"], outfile: "dist/renderer/renderer.js", platform: "browser", format: "iife", target: "chrome140", minify: true }),
]);

cpSync("src/renderer/index.html", "dist/renderer/index.html");
cpSync("src/renderer/styles.css", "dist/renderer/styles.css");
// Baked in at build time; users can still override with the CLONEME_API_URL environment variable.
writeFileSync("dist/config.json", JSON.stringify({ apiBaseUrl: process.env.CLONEME_API_URL || "http://localhost:8787" }));
