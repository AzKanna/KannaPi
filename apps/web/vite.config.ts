import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4173,
    proxy: {
      "/api": "http://127.0.0.1:8081",
      "/flows": "http://127.0.0.1:8081",
      "/actions": "http://127.0.0.1:8081",
      "/findings": "http://127.0.0.1:8081",
      "/ui": { target: "ws://127.0.0.1:8081", ws: true },
    },
  },
});
