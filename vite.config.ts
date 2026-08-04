import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri는 고정 포트를 기대한다(tauri.conf.json의 devUrl과 일치).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    // WebView2(Chromium 최신) 타깃이므로 안전하게 최신 문법 허용.
    target: "esnext",
    outDir: "dist",
  },
});
