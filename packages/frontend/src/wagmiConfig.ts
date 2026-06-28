import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { CHAIN_CONFIGS } from "@circle-fin/x402-batching/client";

// Fetch custom RPC if available
const ARC_TESTNET_RPC = "https://rpc.testnet.arc-node.thecanteenapp.com/v1/swrm_4ba1cb60eb915a5285d7d4fb29e0923321af16cb4f0e2257aa3920a3a33dab2f";

export const supportedChains = [
  CHAIN_CONFIGS.arcTestnet.chain,
  CHAIN_CONFIGS.baseSepolia.chain,
  CHAIN_CONFIGS.sepolia.chain,
  CHAIN_CONFIGS.arbitrumSepolia.chain,
  CHAIN_CONFIGS.optimismSepolia.chain,
  CHAIN_CONFIGS.avalancheFuji.chain,
  CHAIN_CONFIGS.polygonAmoy.chain,
] as const;

export const config = getDefaultConfig({
  appName: "CastPay Monetization Infrastructure",
  projectId: "9417855018635817a2bc54a938634cf4", // Fallback public Project ID for mobile compatibility/testing
  chains: supportedChains,
  transports: {
    [CHAIN_CONFIGS.arcTestnet.chain.id]: http(ARC_TESTNET_RPC),
    [CHAIN_CONFIGS.baseSepolia.chain.id]: http(),
    [CHAIN_CONFIGS.sepolia.chain.id]: http(),
    [CHAIN_CONFIGS.arbitrumSepolia.chain.id]: http(),
    [CHAIN_CONFIGS.optimismSepolia.chain.id]: http(),
    [CHAIN_CONFIGS.avalancheFuji.chain.id]: http(),
    [CHAIN_CONFIGS.polygonAmoy.chain.id]: http(),
  },
  ssr: false,
});
