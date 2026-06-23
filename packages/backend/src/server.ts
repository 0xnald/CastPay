import express from "express";
import cors from "cors";
import * as dotenv from "dotenv";
import * as path from "path";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { createPublicClient, http, fallback, formatUnits, erc20Abi } from "viem";
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
  transport: fallback([
    http(ARC_TESTNET_RPC),
    http("https://5042002.rpc.thirdweb.com")
  ]),
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

interface ActiveStream {
  creatorAddress: string;
  creatorName: string;
  streamUrl: string;
  ratePerSecond: number;
  isActive: boolean;
}

const activeStreams: ActiveStream[] = [];

// Track active viewers by key: `${viewerAddress.toLowerCase()}_${creatorAddress.toLowerCase()}` -> last heartbeat timestamp
const activeViewersMap = new Map<string, number>();

interface CachedSegment {
  buffer: Buffer;
  contentType: string | null;
  timestamp: number;
}

const segmentCache = new Map<string, CachedSegment>();
const CACHE_TTL_MS = 30000; // Cache segments for 30 seconds

// Periodic cache cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, cached] of segmentCache.entries()) {
    if (now - cached.timestamp > CACHE_TTL_MS) {
      segmentCache.delete(key);
    }
  }
}, 10000);

// Periodic active viewers cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, lastSeen] of activeViewersMap.entries()) {
    if (now - lastSeen > 20000) { // expire after 20 seconds of silence
      activeViewersMap.delete(key);
    }
  }
}, 10000);

function getActiveViewerCount(creatorAddress?: string): number {
  const now = Date.now();
  let count = 0;
  for (const [key, lastSeen] of activeViewersMap.entries()) {
    if (now - lastSeen < 15000) { // count as active if seen in the last 15 seconds
      if (creatorAddress) {
        const [, cAddr] = key.split("_");
        if (cAddr === creatorAddress.toLowerCase()) {
          count++;
        }
      } else {
        count++;
      }
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
    const targetCreator = req.query.creator as string;
    const targetAddress = targetCreator ? (targetCreator as `0x${string}`) : sellerAddress;

    const activeViewers = getActiveViewerCount(targetAddress);
    const walletBalance = targetAddress ? await getWalletUsdcBalance(targetAddress) : "0.00";
    let gasBalance = "0.00";
    if (targetAddress) {
      try {
        const balance = await publicClient.getBalance({ address: targetAddress });
        gasBalance = formatUnits(balance, 18);
      } catch (err) {
        console.error("Failed to fetch seller gas balance:", err);
      }
    }
    const gateway = targetAddress ? await getGatewayBalances(targetAddress) : { total: "0.00", available: "0.00", withdrawing: "0.00", withdrawable: "0.00" };

    // Filter heartbeats by creator address
    const filteredHeartbeats = heartbeats.filter(hb => 
      !targetAddress || (hb as any).creatorAddress?.toLowerCase() === targetAddress.toLowerCase()
    );

    // Filter withdrawals by creator address
    const filteredWithdrawals = withdrawals.filter(w => 
      !targetAddress || w.destinationAddress.toLowerCase() === targetAddress.toLowerCase()
    );

    const totalReceived = filteredHeartbeats.reduce((acc, curr) => acc + parseFloat(curr.amount), 0).toFixed(6);

    const stream = activeStreams.find(s => s.creatorAddress.toLowerCase() === targetAddress.toLowerCase());
    const rate = stream ? stream.ratePerSecond : currentRatePerSecond;

    res.json({
      activeViewers,
      totalReceived,
      rate,
      sellerAddress: targetAddress || "0x0000000000000000000000000000000000000000",
      walletBalance,
      gasBalance,
      gateway,
      heartbeats: filteredHeartbeats.slice(-30).reverse(), // last 30 heartbeats
      withdrawals: filteredWithdrawals.slice(-20).reverse(), // last 20 withdrawals
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
  const { address } = req.body;
  if (!address) {
    return res.status(400).json({ error: "address is required" });
  }
  if (!address.startsWith("0x") || address.length !== 42) {
    return res.status(400).json({ error: "Invalid EVM address format" });
  }
  
  sellerAddress = address as `0x${string}`;
  console.log(`[CastPay] Creator profile registered: ${sellerAddress}`);
  res.json({ success: true, sellerAddress });
});

// Endpoint: withdraw funds from Circle Gateway
app.post("/api/withdraw", async (req, res) => {
  const { burnIntent, signature, destinationChain } = req.body;
  if (!burnIntent || !signature || !destinationChain) {
    return res.status(400).json({ error: "burnIntent, signature, and destinationChain are required" });
  }

  const withdrawalId = `w_${Date.now()}`;
  const spec = burnIntent.spec;
  const amountAtomic = spec.value;
  const recipientBytes32 = spec.destinationRecipient;
  const recipient = "0x" + recipientBytes32.slice(-40); // extract address from 32-byte pad
  
  const amountFormatted = (parseFloat(amountAtomic) / 1_000_000).toFixed(6);

  withdrawals.push({
    id: withdrawalId,
    amount: amountFormatted,
    destinationChain,
    destinationAddress: recipient,
    status: "submitted",
    txHash: null,
    timestamp: new Date().toISOString(),
  });

  try {
    const GATEWAY_API_TESTNET = "https://gateway-api-testnet.circle.com/v1";
    
    // Proxy the pre-signed BurnIntent request to Circle Gateway API
    const response = await fetch(`${GATEWAY_API_TESTNET}/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        [{ burnIntent, signature }],
        (_, v) => typeof v === "bigint" ? v.toString() : v
      )
    });

    const result = await response.json();
    if (!response.ok || result.success === false || result.error || !result.attestation || !result.signature) {
      throw new Error(
        `Circle Gateway API error: ${result.message || result.error || JSON.stringify(result)}`
      );
    }

    res.json({
      success: true,
      attestation: result.attestation,
      circleSignature: result.signature,
      amount: amountFormatted,
      destinationChain,
      recipient,
      withdrawalId,
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

// Endpoint: confirm complete withdrawal mint tx hash
app.post("/api/withdraw/confirm", (req, res) => {
  const { id, txHash } = req.body;
  if (!id || !txHash) {
    return res.status(400).json({ error: "id and txHash are required" });
  }
  const idx = withdrawals.findIndex(w => w.id === id);
  if (idx !== -1) {
    withdrawals[idx].status = "confirmed";
    withdrawals[idx].txHash = txHash;
    console.log(`[CastPay] Withdrawal ${id} confirmed with tx: ${txHash}`);
    return res.json({ success: true });
  }
  res.status(404).json({ error: "Withdrawal not found" });
});

// Endpoint: Heartbeat payment receiver (conforms to x402 specification)
app.post("/api/heartbeat", async (req, res) => {
  const paymentSignature = req.headers["payment-signature"] as string;
  const creatorAddress = req.query.creator as string;

  if (!creatorAddress) {
    return res.status(400).json({ error: "creator query parameter is required" });
  }

  // Find the creator stream
  const stream = activeStreams.find(
    (s) => s.creatorAddress.toLowerCase() === creatorAddress.toLowerCase()
  );

  const rate = stream ? stream.ratePerSecond : currentRatePerSecond;
  const targetSellerAddress = stream ? stream.creatorAddress : sellerAddress;

  // Heartbeat is sent every 2 seconds
  const heartbeatInterval = 2;
  const heartbeatPrice = (rate * heartbeatInterval).toFixed(6);
  const amountAtomic = Math.round(parseFloat(heartbeatPrice) * 1_000_000);

  const requirements = {
    scheme: "exact" as const,
    network: ARC_TESTNET_NETWORK,
    asset: ARC_TESTNET_USDC,
    amount: amountAtomic.toString(),
    payTo: targetSellerAddress as `0x${string}`,
    maxTimeoutSeconds: 2592000, // 30 days
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
        url: `/api/heartbeat?creator=${creatorAddress}`,
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

    // Construct relaxed verification requirements to absorb network latency and clock drifts
    const verifyRequirements = {
      ...requirements,
      maxTimeoutSeconds: 2592000, // require 30 days (Circle Gateway minimum requirement for verify/settle)
    };
    logDebug("VERIFY REQ: " + JSON.stringify(verifyRequirements));

    // Verify signature
    const verifyResult = await facilitator.verify(paymentPayload, verifyRequirements);
    if (!verifyResult.isValid) {
      logDebug(`VERIFY FAILED: ${verifyResult.invalidReason} | Payer: ${verifyResult.payer}`);
      return res.status(402).json({
        error: "Payment verification failed",
        reason: verifyResult.invalidReason,
      });
    }

    // Record active viewer immediately after successful verification
    const payer = verifyResult.payer || "unknown";
    activeViewersMap.set(`${payer.toLowerCase()}_${creatorAddress.toLowerCase()}`, Date.now());

    // Settle signature asynchronously in background to prevent blocking the event loop
    facilitator.settle(paymentPayload, verifyRequirements).then((settleResult) => {
      if (!settleResult.success) {
        console.error(`[CastPay] Background settlement failed: ${settleResult.errorReason}`);
        logDebug(`ASYNC SETTLE FAILED: ${settleResult.errorReason}`);
      } else {
        const settledPayer = settleResult.payer || verifyResult.payer || "unknown";
        const heartbeatEvent = {
          id: `hb_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          payer: settledPayer,
          creatorAddress, // Store creator target
          amount: heartbeatPrice,
          timestamp: new Date().toISOString(),
          txHash: settleResult.transaction || null,
        };

        heartbeats.push(heartbeatEvent);
        console.log(`[CastPay] Heartbeat Settled (Async): ${heartbeatPrice} USDC from ${settledPayer} to ${creatorAddress} | Active Viewers: ${getActiveViewerCount(creatorAddress)}`);
      }
    }).catch((err) => {
      console.error("[CastPay] Background settlement exception:", err);
      logDebug(`ASYNC SETTLE EXCEPTION: ${String(err)}`);
    });

    res.header({
      "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({
        success: true,
        network: ARC_TESTNET_NETWORK,
        payer,
      })).toString("base64")
    }).json({ success: true, activeViewers: getActiveViewerCount(creatorAddress) });

  } catch (error) {
    console.error("[CastPay] Error processing heartbeat:", error);
    try {
      const logPath = path.resolve(__dirname, "../../../backend-debug.log");
      require("fs").appendFileSync(logPath, `[${new Date().toISOString()}] EXCEPTION: ${String(error)}\n`);
    } catch (e) {}
    res.status(500).json({ error: "Internal payment processing error", details: String(error) });
  }
});

// Endpoint: register active stream
app.post("/api/streams/register", (req, res) => {
  const { address, name, streamUrl, rate } = req.body;
  if (!address || !name || !streamUrl || typeof rate !== "number") {
    return res.status(400).json({ error: "address, name, streamUrl, and rate are required" });
  }
  if (!address.startsWith("0x") || address.length !== 42) {
    return res.status(400).json({ error: "Invalid EVM address format" });
  }

  // Remove existing stream for this creator address if it exists
  const idx = activeStreams.findIndex(s => s.creatorAddress.toLowerCase() === address.toLowerCase());
  if (idx !== -1) {
    activeStreams.splice(idx, 1);
  }

  activeStreams.push({
    creatorAddress: address,
    creatorName: name,
    streamUrl,
    ratePerSecond: rate,
    isActive: true,
  });

  console.log(`[CastPay] Creator stream registered: ${name} (${address}) -> ${streamUrl} at ${rate} USDC/sec`);
  res.json({ success: true, streams: activeStreams });
});

// Endpoint: stop stream
app.post("/api/streams/stop", (req, res) => {
  const { address } = req.body;
  if (!address) {
    return res.status(400).json({ error: "address is required" });
  }
  const idx = activeStreams.findIndex(s => s.creatorAddress.toLowerCase() === address.toLowerCase());
  if (idx !== -1) {
    activeStreams[idx].isActive = false;
    console.log(`[CastPay] Creator stream stopped: ${activeStreams[idx].creatorName} (${address})`);
    activeStreams.splice(idx, 1); // remove from active directory
    return res.json({ success: true });
  }
  res.status(404).json({ error: "Active stream not found" });
});

// Endpoint: get active streams
app.get("/api/streams", (req, res) => {
  const publicStreams = activeStreams
    .filter(s => s.isActive)
    .map(s => ({
      creatorAddress: s.creatorAddress,
      creatorName: s.creatorName,
      ratePerSecond: s.ratePerSecond,
    }));
  res.json(publicStreams);
});

// Endpoint: gated HLS stream proxy
app.get("/api/stream/:creatorAddress/*", async (req, res) => {
  const { creatorAddress } = req.params;
  const filePath = (req.params as any)[0];
  const viewerAddress = req.query.viewer as string;

  if (!viewerAddress) {
    return res.status(402).json({ error: "Payment Required - viewer address parameter missing" });
  }

  // Verify creator stream is live
  const stream = activeStreams.find(s => s.creatorAddress.toLowerCase() === creatorAddress.toLowerCase());
  if (!stream || !stream.isActive) {
    return res.status(404).json({ error: "Stream offline or not found" });
  }

  // Verify that the viewer has a settled heartbeat in the last 20 seconds for this creator
  const lastSeen = activeViewersMap.get(`${viewerAddress.toLowerCase()}_${creatorAddress.toLowerCase()}`);
  const now = Date.now();
  if (!lastSeen || now - lastSeen > 20000) {
    return res.status(402).json({ error: "Payment Required - No active heartbeat found in the last 20 seconds" });
  }

  // Resolve base upstream URL
  const lastSlash = stream.streamUrl.lastIndexOf("/");
  const baseUrl = stream.streamUrl.substring(0, lastSlash + 1);
  const targetUrl = baseUrl + filePath;

  // 1. If it's a segment file (not .m3u8), check cache first to avoid hitting Owncast
  if (!filePath.endsWith(".m3u8")) {
    const cacheKey = `${creatorAddress.toLowerCase()}_${filePath}`;
    const cached = segmentCache.get(cacheKey);
    const nowMs = Date.now();

    if (cached && (nowMs - cached.timestamp < CACHE_TTL_MS)) {
      if (cached.contentType) {
        res.setHeader("Content-Type", cached.contentType);
      }
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.send(cached.buffer);
    }
  }

  // 2. Cache miss or playlist request: fetch from upstream
  try {
    const upstreamRes = await fetch(targetUrl);
    if (!upstreamRes.ok) {
      return res.status(upstreamRes.status).send("Upstream server error");
    }

    const contentType = upstreamRes.headers.get("content-type");
    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }

    // Set CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (filePath.endsWith(".m3u8")) {
      // Modify playlist to append ?viewer=0x... to all relative links (segments or variant playlists)
      const text = await upstreamRes.text();
      const lines = text.split("\n");
      const modifiedLines = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const separator = trimmed.includes("?") ? "&" : "?";
          return `${trimmed}${separator}viewer=${encodeURIComponent(viewerAddress)}`;
        }
        return line;
      });
      res.send(modifiedLines.join("\n"));
    } else {
      // Stream segment or binary asset
      const buffer = await upstreamRes.arrayBuffer();
      const nodeBuffer = Buffer.from(buffer);

      // Cache the segment
      const cacheKey = `${creatorAddress.toLowerCase()}_${filePath}`;
      segmentCache.set(cacheKey, {
        buffer: nodeBuffer,
        contentType,
        timestamp: Date.now(),
      });

      res.send(nodeBuffer);
    }
  } catch (err) {
    console.error(`[CastPay Proxy] Error proxying ${filePath}:`, err);
    res.status(500).send("Stream proxy error");
  }
});

app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`CastPay Backend Server running on port ${PORT}`);
  console.log(`Stream rate: ${currentRatePerSecond} USDC/second`);
  console.log(`Verifying payments for seller: ${sellerAddress}`);
  console.log(`========================================`);
});
