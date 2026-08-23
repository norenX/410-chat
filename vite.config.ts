import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  publicDir: "../public",
  plugins: [react()],
  resolve: {
    alias: {
      "libsodium-wrappers": fileURLToPath(
        new URL("./node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js", import.meta.url)
      )
    }
  },
  build: {
    outDir: "../dist-client",
    emptyOutDir: true
  }
});
