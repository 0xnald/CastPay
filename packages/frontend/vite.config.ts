import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      protocolImports: true,
    }),
  ],
  define: {
    "process.env.RPC": JSON.stringify(process.env.RPC || "https://rpc.testnet.arc.network"),
  },
  server: {
    port: 3000,
    host: true,
  },
});

