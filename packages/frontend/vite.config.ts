import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import * as path from "path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, "../../"), "");
  return {
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
      "process.env.RPC": JSON.stringify(process.env.RPC || env.RPC || "https://rpc.testnet.arc.network"),
      "process.env.BACKEND_URL": JSON.stringify(process.env.BACKEND_URL || env.BACKEND_URL || "http://localhost:3001"),
    },
    server: {
      port: 3000,
      host: true,
    },
  };
});

