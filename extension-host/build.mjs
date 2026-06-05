// esbuild bundler for the CodeZ extension host.
//
// Produces a single CommonJS file the Tauri host launches with Node:
//   dist/host.js   — the real extension host entry (stdio RPC transport)
//   dist/smoke.js  — an in-process loopback smoke test (no Tauri needed)
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync(new URL("./dist", import.meta.url), { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
  // Extensions `require('vscode')` is intercepted at runtime by our module
  // loader, so it must never be resolved at bundle time.
  external: ["vscode"],
};

await build({
  ...common,
  entryPoints: { host: "src/main.ts" },
  outdir: "dist",
});

await build({
  ...common,
  entryPoints: { smoke: "src/smoke.ts" },
  outdir: "dist",
});

console.log("[extension-host] build complete -> dist/host.js, dist/smoke.js");
