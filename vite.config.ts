import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = Number(process.env.PORT ?? 5174);

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    // Never fall back to another port: the next one up is the API server's.
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    // Served from this computer, so one larger bundle is fine.
    chunkSizeWarningLimit: 2000,
  },
});
