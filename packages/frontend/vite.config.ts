import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import * as path from "path";

export default defineConfig(({ mode }) => {
  const envDir = path.resolve(__dirname, "../../");
  const env = loadEnv(mode, envDir, "");
  const castpayEnv = {
    RPC: process.env.RPC || env.RPC || "https://rpc.testnet.arc.network",
    BACKEND_URL: process.env.BACKEND_URL || env.BACKEND_URL || "http://localhost:3001",
    VITE_CIRCLE_APP_ID: process.env.VITE_CIRCLE_APP_ID || env.VITE_CIRCLE_APP_ID || "",
    VITE_CIRCLE_ENVIRONMENT: process.env.VITE_CIRCLE_ENVIRONMENT || env.VITE_CIRCLE_ENVIRONMENT || "sandbox",
  };

  return {
    envDir,
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
      __CASTPAY_ENV__: JSON.stringify(castpayEnv),
    },
    server: {
      port: 3000,
      strictPort: true,
      host: true,
    },
  };
});

