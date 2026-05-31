import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Relative asset paths so a future Tauri desktop build can load bundled
  // files regardless of how the app protocol/root resolves at runtime.
  base: "./",
  plugins: [react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "app-vendor": ["react", "react-dom", "i18next", "react-i18next", "@tauri-apps/api"],
          monaco: ["monaco-editor", "@monaco-editor/react"],
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
