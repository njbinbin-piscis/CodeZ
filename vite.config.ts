import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as { version: string };

export default defineConfig({
  // Relative asset paths so a future Tauri desktop build can load bundled
  // files regardless of how the app protocol/root resolves at runtime.
  base: "./",
  plugins: [react()],
  clearScreen: false,
  // Expose the app version so the title bar can show which build is running.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "app-vendor": ["react", "react-dom", "i18next", "react-i18next", "@tauri-apps/api"],
          monaco: ["monaco-editor", "@monaco-editor/react"],
          markdown: ["react-markdown", "remark-gfm", "rehype-highlight", "highlight.js"],
        },
      },
    },
  },
  server: {
    port: 5273,
    strictPort: true,
    host: host || false,
    watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
  },
  optimizeDeps: { entries: ["src/main.tsx"] },
});
