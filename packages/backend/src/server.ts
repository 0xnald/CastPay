import express from "express";
import cors from "cors";
import * as dotenv from "dotenv";
import * as path from "path";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { createPublicClient, http, formatUnits, erc20Abi } from "viem";
import { arcTestnet } from "viem/chains";

// Load environment variables from the monorepo root
dotenv.config({ path: path.resolve(__dirname, "../../../.env.local") });

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"],
}));
app.use(express.json());

// Arc Testnet constants
const ARC_TESTNET_NETWORK = "eip155:5042002";
const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000" as const;
const ARC_TESTNET_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const ARC_TESTNET_RPC = "https://rpc.testnet.arc.network";
const ARC_TESTNET_DOMAIN = 26;

let sellerAddress = process.env.SELLER_ADDRESS as `0x${string}`;
let sellerPrivateKey = process.env.SELLER_PRIVATE_KEY as `0x${string}` | undefined;

if (!sellerAddress || !sellerPrivateKey) {
  console.warn("WARNING: SELLER_ADDRESS and SELLER_PRIVATE_KEY must be configured in .env.local");
}

const facilitator = new BatchFacilitatorClient();
const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_TESTNET_RPC),
});

// App State
let currentRatePerSecond = 0.0001; // default: 0.0001 USDC / sec (0.0002 per 2s heartbeat)
const heartbeats: Array<{
  id: string;
  payer: string;
  amount: string;
  timestamp: string;
  txHash: string | null;
}> = [];

const withdrawals: Array<{
  id: string;
  amount: string;
  destinationChain: string;
  destinationAddress: string;
  status: "submitted" | "confirmed" | "failed";
  txHash: string | null;
  timestamp: string;
}> = [];

// Track active viewers by address -> last heartbeat timestamp
const activeViewersMap = new Map<string, number>();

function getActiveViewerCount(): number {
  const now = Date.now();
  let count = 0;
  for (const [address, lastSeen] of activeViewersMap.entries()) {
    if (now - lastSeen < 10000) { // active if heartbeat in last 10 seconds
      count++;
    } else {
      activeViewersMap.delete(address);
    }
  }
  return count;
}

// Utility to get USDC balance
async function getWalletUsdcBalance(address: `0x${string}`): Promise<string> {
  try {
    const balance = await publicClient.readContract({
      address: ARC_TESTNET_USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    });
    return formatUnits(balance, 6);
  } catch (error) {
    console.error("Failed to fetch wallet USDC balance:", error);
    return "0.00";
  }
}

// Utility to fetch Circle Gateway balances
async function getGatewayBalances(address: `0x${string}`) {
  try {
    const GATEWAY_API = "https://gateway-api-testnet.circle.com/v1/balances";
    const gatewayResponse = await fetch(GATEWAY_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "USDC",
        sources: [{ domain: ARC_TESTNET_DOMAIN, depositor: address }],
      }),
    });

    if (!gatewayResponse.ok) {
      throw new Error(`Gateway API returned status ${gatewayResponse.status}`);
    }

    const data = await gatewayResponse.json();
    const bal = data.balances?.find((b: { domain: number }) => b.domain === ARC_TESTNET_DOMAIN);

    const raw = bal?.balance ?? "0";
    const withdrawingRaw = bal?.withdrawing ?? "0";
    const withdrawableRaw = bal?.withdrawable ?? "0";

    const parse = (v: string) => v.includes(".") ? v : formatUnits(BigInt(v), 6);

    const available = parse(raw);
    const withdrawing = parse(withdrawingRaw);
    const withdrawable = parse(withdrawableRaw);
    const total = (parseFloat(available) + parseFloat(withdrawing)).toFixed(6);

    return { total, available, withdrawing, withdrawable };
  } catch (error) {
    console.error("Gateway balance check failed, falling back:", error);
    return { total: "0.00", available: "0.00", withdrawing: "0.00", withdrawable: "0.00" };
  }
}

// Endpoint: root server info
app.get("/", (req, res) => {
  res.json({
    status: "online",
    name: "CastPay Payment Sidecar",
    version: "1.0.0",
    network: "Arc Testnet",
    sellerAddress: sellerAddress || "unconfigured",
  });
});

// Endpoint: get stats for dashboard
app.get("/api/stats", async (req, res) => {
  try {
    const activeViewers = getActiveViewerCount();
    const walletBalance = sellerAddress ? await getWalletUsdcBalance(sellerAddress) : "0.00";
    let gasBalance = "0.00";
    if (sellerAddress) {
      try {
        const balance = await publicClient.getBalance({ address: sellerAddress });
        gasBalance = formatUnits(balance, 18);
      } catch (err) {
        console.error("Failed to fetch seller gas balance:", err);
      }
    }
    const gateway = sellerAddress ? await getGatewayBalances(sellerAddress) : { total: "0.00", available: "0.00", withdrawing: "0.00", withdrawable: "0.00" };

    const totalReceived = heartbeats.reduce((acc, curr) => acc + parseFloat(curr.amount), 0).toFixed(6);

    res.json({
      activeViewers,
      totalReceived,
      rate: currentRatePerSecond,
      sellerAddress: sellerAddress || "0x0000000000000000000000000000000000000000",
      walletBalance,
      gasBalance,
      gateway,
      heartbeats: heartbeats.slice(-30).reverse(), // last 30 heartbeats
      withdrawals: withdrawals.slice(-20).reverse(), // last 20 withdrawals
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch stats", details: String(error) });
  }
});

// Endpoint: configure streaming rate (USDC/sec)
app.post("/api/configure", (req, res) => {
  const { rate } = req.body;
  if (typeof rate !== "number" || rate <= 0) {
    return res.status(400).json({ error: "Invalid rate. Must be a positive number." });
  }
  currentRatePerSecond = rate;
  console.log(`[CastPay] Stream rate updated to: ${currentRatePerSecond} USDC/second`);
  res.json({ success: true, rate: currentRatePerSecond });
});

// Endpoint: register creator profile/wallet dynamically
app.post("/api/register", (req, res) => {
  const { address, privateKey } = req.body;
  if (!address) {
    return res.status(400).json({ error: "address is required" });
  }
  if (!address.startsWith("0x") || address.length !== 42) {
    return res.status(400).json({ error: "Invalid EVM address format" });
  }
  
  sellerAddress = address as `0x${string}`;
  if (privateKey) {
    if (!privateKey.startsWith("0x") || privateKey.length !== 66) {
      return res.status(400).json({ error: "Invalid private key format (must be 66 characters starting with 0x)" });
    }
    sellerPrivateKey = privateKey as `0x${string}`;
  } else {
    sellerPrivateKey = undefined; // clear private key if not provided (read-only mode)
  }

  console.log(`[CastPay] Creator profile registered: ${sellerAddress} (Private Key: ${sellerPrivateKey ? "Configured" : "None"})`);
  res.json({ success: true, sellerAddress, hasPrivateKey: !!sellerPrivateKey });
});

// Endpoint: withdraw funds from Circle Gateway
app.post("/api/withdraw", async (req, res) => {
  const { amount, destinationChain, destinationAddress } = req.body;
  if (!amount || !destinationChain) {
    return res.status(400).json({ error: "amount and destinationChain are required" });
  }

  if (!sellerPrivateKey) {
    return res.status(500).json({ error: "SELLER_PRIVATE_KEY not configured" });
  }

  const withdrawalId = `w_${Date.now()}`;
  const targetAddress = destinationAddress || sellerAddress;

  withdrawals.push({
    id: withdrawalId,
    amount,
    destinationChain,
    destinationAddress: targetAddress,
    status: "submitted",
    txHash: null,
    timestamp: new Date().toISOString(),
  });

  try {
    const gateway = new GatewayClient({
      chain: "arcTestnet",
      privateKey: sellerPrivateKey,
    });

    const result = await gateway.withdraw(amount, {
      chain: destinationChain as any,
      recipient: targetAddress as `0x${string}`,
    });

    const idx = withdrawals.findIndex(w => w.id === withdrawalId);
    if (idx !== -1) {
      withdrawals[idx].status = "confirmed";
      withdrawals[idx].txHash = result.mintTxHash;
    }

    res.json({
      success: true,
      txHash: result.mintTxHash,
      amount,
      destinationChain,
      recipient: targetAddress,
    });
  } catch (error) {
    console.error("Withdrawal error:", error);
    const idx = withdrawals.findIndex(w => w.id === withdrawalId);
    if (idx !== -1) {
      withdrawals[idx].status = "failed";
    }
    res.status(500).json({ error: "Withdrawal failed", details: String(error) });
  }
});

// Endpoint: Heartbeat payment receiver (conforms to x402 specification)
app.post("/api/heartbeat", async (req, res) => {
  const paymentSignature = req.headers["payment-signature"] as string;

  // Heartbeat is sent every 2 seconds
  const heartbeatInterval = 2;
  const heartbeatPrice = (currentRatePerSecond * heartbeatInterval).toFixed(6);
  const amountAtomic = Math.round(parseFloat(heartbeatPrice) * 1_000_000);

  const requirements = {
    scheme: "exact" as const,
    network: ARC_TESTNET_NETWORK,
    asset: ARC_TESTNET_USDC,
    amount: amountAtomic.toString(),
    payTo: sellerAddress,
    maxTimeoutSeconds: 2592000,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: ARC_TESTNET_GATEWAY_WALLET,
    },
  };

  if (!paymentSignature) {
    // Return 402 Payment Required with base64 encoded requirements
    const paymentRequired = {
      x402Version: 2,
      resource: {
        url: "/api/heartbeat",
        description: `CastPay 2-second stream heartbeat (${heartbeatPrice} USDC)`,
        mimeType: "application/json",
      },
      accepts: [requirements],
    };

    return res.status(402).header({
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(paymentRequired)).toString("base64"),
    }).json({ error: "Payment Required" });
  }

  try {
    const paymentPayload = JSON.parse(
      Buffer.from(paymentSignature, "base64").toString("utf-8")
    );

    // Logging for debugging verification issues
    const logDebug = (msg: string) => {
      try {
        const logPath = path.resolve(__dirname, "../../../backend-debug.log");
        require("fs").appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
      } catch (e) {}
    };

    logDebug("PAYLOAD: " + JSON.stringify(paymentPayload));
    logDebug("REQ: " + JSON.stringify(requirements));

    // Verify signature
    const verifyResult = await facilitator.verify(paymentPayload, requirements);
    if (!verifyResult.isValid) {
      logDebug(`VERIFY FAILED: ${verifyResult.invalidReason} | Payer: ${verifyResult.payer}`);
      return res.status(402).json({
        error: "Payment verification failed",
        reason: verifyResult.invalidReason,
      });
    }

    // Settle signature
    const settleResult = await facilitator.settle(paymentPayload, requirements);
    if (!settleResult.success) {
      console.error(`[CastPay] Settlement failed: ${settleResult.errorReason}`);
      logDebug(`SETTLE FAILED: ${settleResult.errorReason}`);
      return res.status(402).json({
        error: "Payment settlement failed",
        reason: settleResult.errorReason,
      });
    }

    // Record success
    const payer = settleResult.payer || verifyResult.payer || "unknown";
    activeViewersMap.set(payer, Date.now());

    const heartbeatEvent = {
      id: `hb_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      payer,
      amount: heartbeatPrice,
      timestamp: new Date().toISOString(),
      txHash: settleResult.transaction || null,
    };

    heartbeats.push(heartbeatEvent);
    console.log(`[CastPay] Heartbeat Settled: ${heartbeatPrice} USDC from ${payer} | Active Viewers: ${getActiveViewerCount()}`);

    res.header({
      "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({
        success: true,
        transaction: settleResult.transaction,
        network: ARC_TESTNET_NETWORK,
        payer,
      })).toString("base64")
    }).json({ success: true, activeViewers: getActiveViewerCount() });

  } catch (error) {
    console.error("[CastPay] Error processing heartbeat:", error);
    try {
      const logPath = path.resolve(__dirname, "../../../backend-debug.log");
      require("fs").appendFileSync(logPath, `[${new Date().toISOString()}] EXCEPTION: ${String(error)}\n`);
    } catch (e) {}
    res.status(500).json({ error: "Internal payment processing error", details: String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`CastPay Backend Server running on port ${PORT}`);
  console.log(`Stream rate: ${currentRatePerSecond} USDC/second`);
  console.log(`Verifying payments for seller: ${sellerAddress}`);
  console.log(`========================================`);
});
