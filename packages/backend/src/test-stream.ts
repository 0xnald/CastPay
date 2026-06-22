import { GatewayClient } from "@circle-fin/x402-batching/client";
import {
  createWalletClient,
  createPublicClient,
  http,
  erc20Abi,
  parseUnits,
  parseEther,
} from "viem";
import { arcTestnet } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as dotenv from "dotenv";
import * as path from "path";

// Load environment variables from the monorepo root
dotenv.config({ path: path.resolve(__dirname, "../../../.env.local") });

const funderKey = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
if (!funderKey) {
  console.error("Missing BUYER_PRIVATE_KEY in .env.local. Run `npm run generate-wallets` first.");
  process.exit(1);
}

const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000" as const;
const ARC_TESTNET_RPC = "https://rpc.testnet.arc.network";
const BACKEND_URL = "http://localhost:3001/api/heartbeat";
const DEPOSIT_AMOUNT = "1.00"; // Deposit 1.00 USDC into the Gateway Wallet
const GAS_FUND_AMOUNT = parseEther("0.01"); // gas is USDC with 18 decimals on Arc Testnet

async function main() {
  console.log("Starting paying viewer simulation...");

  // Generate ephemeral wallet
  const ephemeralKey = generatePrivateKey();
  const ephemeralAccount = privateKeyToAccount(ephemeralKey);
  console.log(`Ephemeral viewer wallet: ${ephemeralAccount.address}`);

  // Setup viem clients
  const funderAccount = privateKeyToAccount(funderKey!);
  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(ARC_TESTNET_RPC),
  });
  const funderWallet = createWalletClient({
    account: funderAccount,
    chain: arcTestnet,
    transport: http(ARC_TESTNET_RPC),
  });

  console.log(`Funding ephemeral wallet from buyer wallet ${funderAccount.address}...`);

  // Retry logic for transaction funding (to handle nonce mismatches)
  async function sendTxWithRetry(fn: () => Promise<`0x${string}`>, label: string) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const hash = await fn();
        await publicClient.waitForTransactionReceipt({ hash });
        console.log(`  ${label} completed: ${hash.slice(0, 10)}...`);
        return hash;
      } catch (err) {
        console.warn(`  Attempt ${attempt + 1} for ${label} failed: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw new Error(`Failed to fund ephemeral wallet after 5 attempts.`);
  }

  // 1. Send native USDC for gas
  await sendTxWithRetry(
    () => funderWallet.sendTransaction({ to: ephemeralAccount.address, value: GAS_FUND_AMOUNT }),
    "Gas funding"
  );

  // 2. Transfer ERC20 USDC
  const usdcAmount = parseUnits(DEPOSIT_AMOUNT, 6);
  await sendTxWithRetry(
    () => funderWallet.writeContract({
      address: ARC_TESTNET_USDC,
      abi: erc20Abi,
      functionName: "transfer",
      args: [ephemeralAccount.address, usdcAmount],
    }),
    "USDC transfer"
  );

  // Initialize GatewayClient with the ephemeral wallet
  const gateway = new GatewayClient({
    chain: "arcTestnet",
    privateKey: ephemeralKey,
  });

  console.log(`Depositing ${DEPOSIT_AMOUNT} USDC into the Circle Gateway...`);
  const depResult = await gateway.deposit(DEPOSIT_AMOUNT);
  console.log(`Deposit completed: ${depResult.depositTxHash}`);

  const initialBalances = await gateway.getBalances();
  console.log(`Gateway available balance: ${initialBalances.gateway.formattedAvailable} USDC`);

  console.log("\nStarting 2-second heartbeat billing simulation loop. Press Ctrl+C to exit.");

  let heartbeatCount = 0;
  let totalPaid = 0;

  const heartbeatInterval = setInterval(async () => {
    const start = Date.now();
    try {
      // Send heartbeat using the gateway pay method (handles 402 challenge/response automatically)
      const result = await gateway.pay(BACKEND_URL, { method: "POST" });
      const duration = Date.now() - start;
      heartbeatCount++;
      const amount = parseFloat(result.formattedAmount);
      totalPaid += amount;

      console.log(`[Heartbeat #${heartbeatCount}] Paid ${result.formattedAmount} USDC (${duration}ms) | Total paid: ${totalPaid.toFixed(6)} USDC | Tx: ${result.transaction ? result.transaction.slice(0, 10) + '...' : 'pending'}`);
    } catch (err) {
      console.error(`[Heartbeat #${heartbeatCount + 1}] Payment failed: ${(err as Error).message}`);
    }
  }, 2000);

  process.on("SIGINT", () => {
    clearInterval(heartbeatInterval);
    console.log(`\nSimulation stopped. Sent ${heartbeatCount} heartbeats. Total paid: ${totalPaid.toFixed(6)} USDC.`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Simulation failed:", err);
  process.exit(1);
});
