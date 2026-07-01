import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { CHAIN_CONFIGS, GatewayClient } from "@circle-fin/x402-batching/client";
import {
  Blockchain,
  initiateUserControlledWalletsClient,
} from "@circle-fin/user-controlled-wallets";
import { createPublicClient, http, fallback, formatUnits, parseUnits, erc20Abi, isAddress } from "viem";
import { arcTestnet } from "viem/chains";

const REPO_ROOT = path.resolve(__dirname, "../../..");

// Load environment variables from the monorepo root
dotenv.config({ path: path.resolve(REPO_ROOT, ".env.local") });

const configuredStateFilePath = process.env.STATE_FILE_PATH;
const primaryStateFilePath = configuredStateFilePath
  ? path.resolve(REPO_ROOT, configuredStateFilePath)
  : path.resolve(REPO_ROOT, "packages/backend/data/state.json");
const legacyRelativeStateFilePath = configuredStateFilePath && !path.isAbsolute(configuredStateFilePath)
  ? path.resolve(process.cwd(), configuredStateFilePath)
  : undefined;
const STATE_FILE_PATH =
  legacyRelativeStateFilePath &&
  legacyRelativeStateFilePath !== primaryStateFilePath &&
  !fs.existsSync(primaryStateFilePath) &&
  fs.existsSync(legacyRelativeStateFilePath)
    ? legacyRelativeStateFilePath
    : primaryStateFilePath;

fs.mkdirSync(path.dirname(STATE_FILE_PATH), { recursive: true });


const app = express();
const PORT = process.env.PORT || 3001;

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "https://castpay.app",
];
const configuredAllowedOrigins = [
  process.env.FRONTEND_ORIGIN,
  process.env.FRONTEND_URL,
  ...(process.env.CORS_ORIGINS || "").split(","),
]
  .map((origin) => origin?.trim())
  .filter((origin): origin is string => Boolean(origin));
const allowedOrigins = new Set([...DEFAULT_ALLOWED_ORIGINS, ...configuredAllowedOrigins]);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"],
}));
app.use(express.json());

// Arc Testnet constants
const ARC_TESTNET_NETWORK = "eip155:5042002";
const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000" as const;
const ARC_TESTNET_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const ARC_TESTNET_RPC = process.env.RPC || "https://rpc.testnet.arc.network";
const ARC_TESTNET_DOMAIN = 26;
const PLATFORM_WALLET = "0xDF04435F24bC101FCDc05Dc88D2911194De1F9FA";
const CIRCLE_BASE_URL = process.env.CIRCLE_BASE_URL || "https://api.circle.com";
const CIRCLE_MAX_DEPOSIT_ATOMIC = 100_000_000n; // 100 USDC, 6 decimals, testnet safety guardrail.
const CIRCLE_MAX_WITHDRAW_ATOMIC = 100_000_000n; // 100 USDC testnet Gateway withdrawal guardrail.
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

const CIRCLE_CHAIN_CONFIGS = {
  arcTestnet: {
    appChain: "arcTestnet",
    circleBlockchain: Blockchain.ArcTestnet,
    domain: CHAIN_CONFIGS.arcTestnet.domain,
    usdc: CHAIN_CONFIGS.arcTestnet.usdc,
    gatewayWallet: CHAIN_CONFIGS.arcTestnet.gatewayWallet,
    gatewayMinter: CHAIN_CONFIGS.arcTestnet.gatewayMinter,
  },
  baseSepolia: {
    appChain: "baseSepolia",
    circleBlockchain: Blockchain.BaseSepolia,
    domain: CHAIN_CONFIGS.baseSepolia.domain,
    usdc: CHAIN_CONFIGS.baseSepolia.usdc,
    gatewayWallet: CHAIN_CONFIGS.baseSepolia.gatewayWallet,
    gatewayMinter: CHAIN_CONFIGS.baseSepolia.gatewayMinter,
  },
  sepolia: {
    appChain: "sepolia",
    circleBlockchain: Blockchain.EthSepolia,
    domain: CHAIN_CONFIGS.sepolia.domain,
    usdc: CHAIN_CONFIGS.sepolia.usdc,
    gatewayWallet: CHAIN_CONFIGS.sepolia.gatewayWallet,
    gatewayMinter: CHAIN_CONFIGS.sepolia.gatewayMinter,
  },
  arbitrumSepolia: {
    appChain: "arbitrumSepolia",
    circleBlockchain: Blockchain.ArbSepolia,
    domain: CHAIN_CONFIGS.arbitrumSepolia.domain,
    usdc: CHAIN_CONFIGS.arbitrumSepolia.usdc,
    gatewayWallet: CHAIN_CONFIGS.arbitrumSepolia.gatewayWallet,
    gatewayMinter: CHAIN_CONFIGS.arbitrumSepolia.gatewayMinter,
  },
  optimismSepolia: {
    appChain: "optimismSepolia",
    circleBlockchain: Blockchain.OpSepolia,
    domain: CHAIN_CONFIGS.optimismSepolia.domain,
    usdc: CHAIN_CONFIGS.optimismSepolia.usdc,
    gatewayWallet: CHAIN_CONFIGS.optimismSepolia.gatewayWallet,
    gatewayMinter: CHAIN_CONFIGS.optimismSepolia.gatewayMinter,
  },
  avalancheFuji: {
    appChain: "avalancheFuji",
    circleBlockchain: Blockchain.AvaxFuji,
    domain: CHAIN_CONFIGS.avalancheFuji.domain,
    usdc: CHAIN_CONFIGS.avalancheFuji.usdc,
    gatewayWallet: CHAIN_CONFIGS.avalancheFuji.gatewayWallet,
    gatewayMinter: CHAIN_CONFIGS.avalancheFuji.gatewayMinter,
  },
  polygonAmoy: {
    appChain: "polygonAmoy",
    circleBlockchain: Blockchain.MaticAmoy,
    domain: CHAIN_CONFIGS.polygonAmoy.domain,
    usdc: CHAIN_CONFIGS.polygonAmoy.usdc,
    gatewayWallet: CHAIN_CONFIGS.polygonAmoy.gatewayWallet,
    gatewayMinter: CHAIN_CONFIGS.polygonAmoy.gatewayMinter,
  },
} as const;

type CircleAppChain = keyof typeof CIRCLE_CHAIN_CONFIGS;
const ALLOWED_CIRCLE_BLOCKCHAINS = new Set<string>(
  Object.values(CIRCLE_CHAIN_CONFIGS).map((config) => config.circleBlockchain)
);

let sellerAddress = process.env.SELLER_ADDRESS as `0x${string}`;
let sellerPrivateKey = process.env.SELLER_PRIVATE_KEY as `0x${string}` | undefined;

if (!sellerAddress || !sellerPrivateKey) {
  console.warn("WARNING: SELLER_ADDRESS and SELLER_PRIVATE_KEY must be configured in .env.local");
}

const facilitator = new BatchFacilitatorClient();
const circleWalletsClient = process.env.CIRCLE_API_KEY
  ? initiateUserControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY,
      baseUrl: CIRCLE_BASE_URL,
      userAgent: "CastPay/1.0.0",
    })
  : null;
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
  creatorAddress?: string;
  platformFee?: {
    amount: string;
    recipient: string;
    spec: any;
  };
  attestation?: string | null;
  circleSignature?: string | null;
  gatewaySubmittedAt?: string;
  status: "submitted" | "ready_to_claim" | "confirmed" | "failed";
  txHash: string | null;
  timestamp: string;
}> = [];

interface ActiveStream {
  creatorAddress: string;
  creatorName: string;
  streamUrl: string;
  ratePerSecond: number;
  isActive: boolean;
  platform?: "owncast" | "jellyfin" | "peertube";
}

interface JellyfinSession {
  sessionId: string;
  viewerAddress: string;
  creatorAddress: string;
  ratePerMinute: number;
  startTimestamp: number;
  lastSettleTimestamp: number;
  totalSettledAmount: number;
  itemName: string;
  isActive: boolean;
}

interface PeerTubeTransaction {
  id: string;
  viewerAddress: string;
  creatorAddress: string;
  amount: number;
  videoId: string;
  videoTitle: string;
  timestamp: string;
  txHash: string | null;
}

interface PlatformFee {
  id: string;
  amount: string;
  destinationChain: string;
  recipient: string;
  spec: any;
  attestation: string | null;
  circleSignature: string | null;
  status: "pending_claim" | "claimed";
  txHash: string | null;
  timestamp: string;
  withdrawalId?: string;
}

const activeStreams: ActiveStream[] = [];
let historicalStreamCount = 0;
const jellyfinSessions: JellyfinSession[] = [];
const peertubeTransactions: PeerTubeTransaction[] = [];
const platformFees: PlatformFee[] = [];

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE_PATH, "utf8"));
      heartbeats.length = 0;
      withdrawals.length = 0;
      activeStreams.length = 0;
      jellyfinSessions.length = 0;
      peertubeTransactions.length = 0;
      platformFees.length = 0;
      if (Array.isArray(data.heartbeats)) heartbeats.push(...data.heartbeats);
      if (Array.isArray(data.withdrawals)) withdrawals.push(...data.withdrawals);
      if (Array.isArray(data.activeStreams)) activeStreams.push(...data.activeStreams);
      if (Array.isArray(data.jellyfinSessions)) jellyfinSessions.push(...data.jellyfinSessions);
      if (Array.isArray(data.peertubeTransactions)) peertubeTransactions.push(...data.peertubeTransactions);
      if (Array.isArray(data.platformFees)) platformFees.push(...data.platformFees);
      historicalStreamCount = typeof data.historicalStreamCount === "number" ? data.historicalStreamCount : 0;
      console.log(`[CastPay] State loaded: ${heartbeats.length} heartbeats, ${withdrawals.length} withdrawals, ${jellyfinSessions.length} Jellyfin sessions, ${peertubeTransactions.length} PeerTube txs, ${platformFees.length} platform fees.`);
    } else {
      console.log("[CastPay] No state file found. Starting fresh.");
    }
  } catch (error) {
    console.error("[CastPay] Error loading state:", error);
  }
}

function saveState() {
  try {
    const data = {
      heartbeats,
      withdrawals,
      activeStreams,
      historicalStreamCount,
      jellyfinSessions,
      peertubeTransactions,
      platformFees,
    };
    const dir = path.dirname(STATE_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.error("[CastPay] Error saving state:", error);
  }
}

// Initial state load
loadState();


// Track active viewers by key: `${viewerAddress.toLowerCase()}_${creatorAddress.toLowerCase()}` -> last heartbeat timestamp
const activeViewersMap = new Map<string, number>();

interface CachedSegment {
  buffer: Buffer;
  contentType: string | null;
  timestamp: number;
}

interface CachedPlaylist {
  text: string;
  contentType: string | null;
  timestamp: number;
}

interface CachedStats {
  walletBalance: string;
  gasBalance: string;
  gateway: any;
  timestamp: number;
}

const segmentCache = new Map<string, CachedSegment>();
const playlistCache = new Map<string, CachedPlaylist>();
const statsCache = new Map<string, CachedStats>();

const CACHE_TTL_MS = 30000; // Cache segments for 30 seconds
const PLAYLIST_CACHE_TTL_MS = 2000; // Cache playlists for 2 seconds
const STATS_CACHE_TTL_MS = 10000; // Cache stats for 10 seconds

const circleWalletLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/circle", circleWalletLimiter);

function validationError(message: string) {
  const error = new Error(message);
  (error as any).statusCode = 400;
  return error;
}

function getRequiredString(body: any, field: string, minLength = 1, maxLength = 4096): string {
  const value = body?.[field];
  if (typeof value !== "string") {
    throw validationError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length < minLength || trimmed.length > maxLength) {
    throw validationError(`${field} must be between ${minLength} and ${maxLength} characters`);
  }
  return trimmed;
}

function getCircleClientOrThrow() {
  if (!circleWalletsClient) {
    const error = new Error("Circle Wallets are not configured. Set CIRCLE_API_KEY on the backend.");
    (error as any).statusCode = 503;
    throw error;
  }
  return circleWalletsClient;
}

function getCircleResponseDetails(error: any) {
  const data = error?.response?.data ?? error?.error?.response?.data ?? error?.data;
  if (!data || typeof data !== "object") return undefined;

  const details: Record<string, unknown> = {};
  for (const key of ["code", "message", "errors", "details", "field"]) {
    if (data[key] !== undefined) details[key] = data[key];
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

function sendCircleError(res: express.Response, error: any, context: Record<string, unknown> = {}) {
  const statusCode = typeof error?.statusCode === "number"
    ? error.statusCode
    : typeof error?.status === "number" && error.status >= 400 && error.status < 500
      ? 400
      : 502;
  const code = typeof error?.code === "number" || typeof error?.code === "string" ? error.code : undefined;
  const message = typeof error?.message === "string" ? error.message : "Circle Wallet request failed";
  const details = getCircleResponseDetails(error);

  console.error("[Circle Wallet] request failed", {
    ...context,
    statusCode,
    code,
    message,
    details,
  });

  res.status(statusCode).json({
    error: "Circle Wallet request failed",
    code,
    message,
    details,
  });
}

function validateCircleUserId(userId: string) {
  if (!/^[A-Za-z0-9._:@-]{5,128}$/.test(userId)) {
    throw validationError("userId must be 5-128 characters and contain only letters, numbers, '.', '_', ':', '@', or '-'.");
  }
}

function validateUserToken(userToken: string) {
  if (userToken.length < 20 || userToken.length > 4096) {
    throw validationError("userToken has an invalid length");
  }
}

function validateCircleWalletId(walletId: string) {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(walletId)) {
    throw validationError("walletId has an invalid format");
  }
}

function validatePositiveAtomic(value: string, field: string, max: bigint, label: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw validationError(`${field} must be a positive integer string`);
  }
  const parsed = BigInt(value);
  if (parsed > max) {
    throw validationError(`${label} exceed the configured testnet safety limit`);
  }
  return parsed;
}

function validateAmountAtomic(amountAtomic: string): bigint {
  return validatePositiveAtomic(amountAtomic, "amountAtomic", CIRCLE_MAX_DEPOSIT_ATOMIC, "Circle Wallet deposits");
}

function validateWithdrawAtomic(amountAtomic: string): bigint {
  return validatePositiveAtomic(amountAtomic, "withdrawAtomic", CIRCLE_MAX_WITHDRAW_ATOMIC, "Circle Gateway withdrawals");
}

function padAddressToBytes32(address: string) {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

function getCircleChainByAppChain(appChain: string) {
  const config = CIRCLE_CHAIN_CONFIGS[appChain as CircleAppChain];
  if (!config) {
    throw validationError("destinationChain is not supported for Circle Wallet creator operations");
  }
  return config;
}

function getCircleBlockchain(value: unknown) {
  const blockchain = typeof value === "string" && value.trim() ? value.trim() : Blockchain.ArcTestnet;
  if (!ALLOWED_CIRCLE_BLOCKCHAINS.has(blockchain)) {
    throw validationError("blockchain is not supported for Circle Wallet operations");
  }
  return blockchain as Blockchain;
}

function validateHexBytes(value: string, field: string) {
  if (!/^0x[0-9a-fA-F]*$/.test(value) || value.length < 4 || value.length % 2 !== 0) {
    throw validationError(`${field} must be a valid hex bytes string`);
  }
}

function validateBytes32Address(value: unknown, field: string) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw validationError(`${field} must be a bytes32 encoded address`);
  }
  const address = `0x${value.slice(-40)}`;
  if (!isAddress(address)) {
    throw validationError(`${field} must encode a valid EVM address`);
  }
  return value.toLowerCase();
}

function normalizeAtomicField(value: unknown, field: string) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string") return value;
  throw validationError(`${field} must be a positive integer string`);
}

function parseTypedData(raw: unknown) {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      throw validationError("typedData must be valid JSON");
    }
  }
  if (!raw || typeof raw !== "object") {
    throw validationError("typedData must be an object");
  }
  return raw as any;
}

function validateGatewayBurnTypedData(body: any) {
  const destinationChain = getRequiredString(body, "destinationChain", 3, 32);
  const destinationConfig = getCircleChainByAppChain(destinationChain);
  const typedData = parseTypedData(body?.typedData);
  const domain = typedData?.domain;
  const message = typedData?.message;
  const spec = message?.spec;

  if (domain?.name !== "GatewayWallet" || domain?.version !== "1") {
    throw validationError("typedData domain must be GatewayWallet v1");
  }
  if (typedData?.primaryType !== "BurnIntent") {
    throw validationError("typedData primaryType must be BurnIntent");
  }
  if (!spec || typeof spec !== "object") {
    throw validationError("typedData message.spec is required");
  }

  const sourceDepositor = validateBytes32Address(spec.sourceDepositor, "sourceDepositor");
  const sourceSigner = validateBytes32Address(spec.sourceSigner, "sourceSigner");
  if (sourceDepositor !== sourceSigner) {
    throw validationError("sourceDepositor and sourceSigner must match");
  }
  if (Number(spec.sourceDomain) !== CIRCLE_CHAIN_CONFIGS.arcTestnet.domain) {
    throw validationError("sourceDomain must be Arc Testnet");
  }
  if (Number(spec.destinationDomain) !== destinationConfig.domain) {
    throw validationError("destinationDomain does not match destinationChain");
  }
  if (String(spec.sourceContract).toLowerCase() !== padAddressToBytes32(CIRCLE_CHAIN_CONFIGS.arcTestnet.gatewayWallet).toLowerCase()) {
    throw validationError("sourceContract must be the Arc Testnet Gateway Wallet");
  }
  if (String(spec.destinationContract).toLowerCase() !== padAddressToBytes32(destinationConfig.gatewayMinter).toLowerCase()) {
    throw validationError("destinationContract must be the selected Gateway Minter");
  }
  if (String(spec.sourceToken).toLowerCase() !== padAddressToBytes32(CIRCLE_CHAIN_CONFIGS.arcTestnet.usdc).toLowerCase()) {
    throw validationError("sourceToken must be Arc Testnet USDC");
  }
  if (String(spec.destinationToken).toLowerCase() !== padAddressToBytes32(destinationConfig.usdc).toLowerCase()) {
    throw validationError("destinationToken must be the selected chain USDC");
  }
  if (String(spec.destinationCaller).toLowerCase() !== ZERO_BYTES32) {
    throw validationError("destinationCaller must be zero address for public claim");
  }

  validateWithdrawAtomic(normalizeAtomicField(spec.value, "spec.value"));
  validatePositiveAtomic(normalizeAtomicField(message.maxFee, "maxFee"), "maxFee", 1_000_000n, "Circle Gateway withdrawal fees");

  return JSON.stringify(typedData, (_, value) => typeof value === "bigint" ? value.toString() : value);
}

function buildCircleContractExecution(body: any) {
  const action = getRequiredString(body, "action", 1, 32);
  const walletId = getRequiredString(body, "walletId", 6, 128);
  validateCircleWalletId(walletId);

  if (action === "approve" || action === "depositFor") {
    const amountAtomic = getRequiredString(body, "amountAtomic", 1, 32);
    validateAmountAtomic(amountAtomic);

    if (action === "approve") {
      return {
        walletId,
        blockchain: Blockchain.ArcTestnet,
        contractAddress: ARC_TESTNET_USDC,
        abiFunctionSignature: "approve(address,uint256)",
        abiParameters: [ARC_TESTNET_GATEWAY_WALLET, amountAtomic],
      };
    }

    const sessionAddress = getRequiredString(body, "sessionAddress", 42, 42);
    if (!isAddress(sessionAddress)) {
      throw validationError("sessionAddress must be a valid EVM address");
    }
    return {
      walletId,
      blockchain: Blockchain.ArcTestnet,
      contractAddress: ARC_TESTNET_GATEWAY_WALLET,
      abiFunctionSignature: "depositFor(address,address,uint256)",
      abiParameters: [ARC_TESTNET_USDC, sessionAddress, amountAtomic],
    };
  }

  if (action === "gatewayMint") {
    const destinationChain = getRequiredString(body, "destinationChain", 3, 32);
    const destinationConfig = getCircleChainByAppChain(destinationChain);
    const attestation = getRequiredString(body, "attestation", 4, 30000);
    const circleSignature = getRequiredString(body, "circleSignature", 4, 30000);
    validateHexBytes(attestation, "attestation");
    validateHexBytes(circleSignature, "circleSignature");

    return {
      walletId,
      blockchain: destinationConfig.circleBlockchain,
      contractAddress: destinationConfig.gatewayMinter,
      abiFunctionSignature: "gatewayMint(bytes,bytes)",
      abiParameters: [attestation, circleSignature],
    };
  }

  throw validationError("action must be approve, depositFor, or gatewayMint");
}

// Periodic cache cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, cached] of segmentCache.entries()) {
    if (now - cached.timestamp > CACHE_TTL_MS) {
      segmentCache.delete(key);
    }
  }
  for (const [key, cached] of playlistCache.entries()) {
    if (now - cached.timestamp > PLAYLIST_CACHE_TTL_MS) {
      playlistCache.delete(key);
    }
  }
  for (const [key, cached] of statsCache.entries()) {
    if (now - cached.timestamp > STATS_CACHE_TTL_MS) {
      statsCache.delete(key);
    }
  }
}, 10000);

// Periodic active viewers cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, lastSeen] of activeViewersMap.entries()) {
    if (now - lastSeen > 60000) { // expire after 60 seconds of silence
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

// Circle User-Controlled Wallet viewer routes
app.post("/api/circle/users", async (req, res) => {
  try {
    const client = getCircleClientOrThrow();
    const userId = getRequiredString(req.body, "userId", 5, 128);
    validateCircleUserId(userId);

    try {
      const response = await client.createUser({ userId });
      res.json({ success: true, alreadyExists: false, user: response.data ?? null });
    } catch (error: any) {
      if (error?.code === 155101) {
        res.json({ success: true, alreadyExists: true, code: error.code, message: error.message });
        return;
      }
      throw error;
    }
  } catch (error) {
    sendCircleError(res, error);
  }
});

app.post("/api/circle/token", async (req, res) => {
  try {
    const client = getCircleClientOrThrow();
    const userId = getRequiredString(req.body, "userId", 5, 128);
    validateCircleUserId(userId);

    const response = await client.createUserToken({ userId });
    res.json({
      success: true,
      userToken: response.data?.userToken,
      encryptionKey: response.data?.encryptionKey,
    });
  } catch (error) {
    sendCircleError(res, error);
  }
});

app.post("/api/circle/initialize", async (req, res) => {
  try {
    const client = getCircleClientOrThrow();
    const userToken = getRequiredString(req.body, "userToken", 20, 4096);
    validateUserToken(userToken);

    try {
      const response = await client.createUserPinWithWallets({
        userToken,
        blockchains: [Blockchain.ArcTestnet],
        accountType: "EOA" as any,
      });
      res.json({
        success: true,
        alreadyInitialized: false,
        challengeId: response.data?.challengeId,
        accountType: "EOA" as any,
        blockchain: Blockchain.ArcTestnet,
      });
    } catch (error: any) {
      if (error?.code === 155106) {
        res.json({ success: true, alreadyInitialized: true, code: error.code, message: error.message });
        return;
      }
      throw error;
    }
  } catch (error) {
    sendCircleError(res, error);
  }
});

app.post("/api/circle/wallets/create", async (req, res) => {
  try {
    const client = getCircleClientOrThrow();
    const userToken = getRequiredString(req.body, "userToken", 20, 4096);
    const blockchain = getCircleBlockchain(req.body?.blockchain);
    validateUserToken(userToken);

    const response = await client.createWallet({
      userToken,
      blockchains: [blockchain],
      accountType: "EOA" as any,
    });
    res.json({
      success: true,
      challengeId: response.data?.challengeId,
      accountType: "EOA" as any,
      blockchain,
    });
  } catch (error) {
    sendCircleError(res, error);
  }
});

app.post("/api/circle/wallets", async (req, res) => {
  try {
    const client = getCircleClientOrThrow();
    const userToken = getRequiredString(req.body, "userToken", 20, 4096);
    const blockchain = getCircleBlockchain(req.body?.blockchain);
    validateUserToken(userToken);

    const response = await client.listWallets({
      userToken,
      blockchain,
    });
    const wallets = response.data?.wallets ?? [];
    res.json({ success: true, wallets, blockchain });
  } catch (error) {
    sendCircleError(res, error);
  }
});

app.post("/api/circle/wallets/balances", async (req, res) => {
  try {
    const client = getCircleClientOrThrow();
    const userToken = getRequiredString(req.body, "userToken", 20, 4096);
    const walletId = getRequiredString(req.body, "walletId", 6, 128);
    validateUserToken(userToken);
    validateCircleWalletId(walletId);

    const response = await client.getWalletTokenBalance({
      userToken,
      walletId,
      tokenAddresses: [ARC_TESTNET_USDC],
      includeAll: false,
    });
    const tokenBalances = response.data?.tokenBalances ?? [];
    const usdcBalance = tokenBalances.find((balance: any) =>
      balance?.token?.tokenAddress?.toLowerCase() === ARC_TESTNET_USDC.toLowerCase() ||
      balance?.token?.symbol === "USDC"
    );
    res.json({ success: true, tokenBalances, usdcBalance });
  } catch (error) {
    sendCircleError(res, error);
  }
});

app.post("/api/circle/transactions/estimate-contract", async (req, res) => {
  try {
    const client = getCircleClientOrThrow();
    const userToken = getRequiredString(req.body, "userToken", 20, 4096);
    validateUserToken(userToken);
    const execution = buildCircleContractExecution(req.body);

    const response = await client.estimateContractExecutionFee({
      userToken,
      contractAddress: execution.contractAddress,
      abiFunctionSignature: execution.abiFunctionSignature,
      abiParameters: execution.abiParameters,
      source: { walletId: execution.walletId },
    });
    res.json({ success: true, estimate: response.data });
  } catch (error) {
    sendCircleError(res, error, {
      route: "/api/circle/transactions/estimate-contract",
      action: req.body?.action,
    });
  }
});

app.post("/api/circle/transactions/contract", async (req, res) => {
  try {
    const client = getCircleClientOrThrow();
    const userToken = getRequiredString(req.body, "userToken", 20, 4096);
    validateUserToken(userToken);
    const execution = buildCircleContractExecution(req.body);

    const response = await client.createUserTransactionContractExecutionChallenge({
      userToken,
      walletId: execution.walletId,
      contractAddress: execution.contractAddress,
      abiFunctionSignature: execution.abiFunctionSignature,
      abiParameters: execution.abiParameters,
      fee: { type: "level", config: { feeLevel: "MEDIUM" as any } },
    });
    res.json({
      success: true,
      challengeId: response.data?.challengeId,
      action: req.body?.action,
      blockchain: execution.blockchain,
    });
  } catch (error) {
    sendCircleError(res, error, {
      route: "/api/circle/transactions/contract",
      action: req.body?.action,
    });
  }
});

app.post("/api/circle/signatures/typed-data", async (req, res) => {
  try {
    const client = getCircleClientOrThrow();
    const userToken = getRequiredString(req.body, "userToken", 20, 4096);
    const walletId = getRequiredString(req.body, "walletId", 6, 128);
    const action = getRequiredString(req.body, "action", 1, 64);
    validateUserToken(userToken);
    validateCircleWalletId(walletId);
    if (action !== "gatewayBurnIntent") {
      throw validationError("action must be gatewayBurnIntent");
    }

    const data = validateGatewayBurnTypedData(req.body);
    const response = await client.signTypedData({
      userToken,
      walletId,
      data,
      memo: "Authorize CastPay Circle Gateway withdrawal",
    });
    res.json({
      success: true,
      challengeId: response.data?.challengeId,
      action,
    });
  } catch (error) {
    sendCircleError(res, error);
  }
});

app.post("/api/circle/transactions/list", async (req, res) => {
  try {
    const client = getCircleClientOrThrow();
    const userToken = getRequiredString(req.body, "userToken", 20, 4096);
    const walletId = getRequiredString(req.body, "walletId", 6, 128);
    const blockchain = getCircleBlockchain(req.body?.blockchain);
    validateUserToken(userToken);
    validateCircleWalletId(walletId);

    const response = await client.listTransactions({
      userToken,
      walletIds: [walletId],
      blockchain,
      pageSize: 10,
      order: "DESC" as any,
    });
    res.json({ success: true, transactions: response.data?.transactions ?? [], blockchain });
  } catch (error) {
    sendCircleError(res, error);
  }
});

app.post("/api/circle/transactions/status", async (req, res) => {
  try {
    const client = getCircleClientOrThrow();
    const userToken = getRequiredString(req.body, "userToken", 20, 4096);
    const transactionId = getRequiredString(req.body, "transactionId", 6, 128);
    validateUserToken(userToken);

    const response = await client.getTransaction({
      userToken,
      id: transactionId,
    });
    res.json({ success: true, transaction: response.data?.transaction ?? response.data });
  } catch (error) {
    sendCircleError(res, error);
  }
});

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
    if (!targetCreator) {
      return res.json({
        activeViewers: 0,
        totalReceived: "0.000000",
        rate: currentRatePerSecond,
        sellerAddress: "",
        walletBalance: "0.00",
        gasBalance: "0.00",
        gateway: { total: "0.00", available: "0.00", withdrawing: "0.00", withdrawable: "0.00" },
        heartbeats: [],
        withdrawals: [],
      });
    }
    const targetAddress = targetCreator as `0x${string}`;

    const activeViewers = getActiveViewerCount(targetAddress);
    
    // In-memory cache for on-chain/Circle Gateway queries
    const cacheKey = targetAddress ? targetAddress.toLowerCase() : "none";
    const cached = statsCache.get(cacheKey);
    const now = Date.now();

    let walletBalance = "0.00";
    let gasBalance = "0.00";
    let gateway = { total: "0.00", available: "0.00", withdrawing: "0.00", withdrawable: "0.00" };

    if (cached && (now - cached.timestamp < STATS_CACHE_TTL_MS)) {
      walletBalance = cached.walletBalance;
      gasBalance = cached.gasBalance;
      gateway = cached.gateway;
    } else {
      walletBalance = targetAddress ? await getWalletUsdcBalance(targetAddress) : "0.00";
      if (targetAddress) {
        try {
          const balance = await publicClient.getBalance({ address: targetAddress });
          gasBalance = formatUnits(balance, 18);
        } catch (err) {
          console.error("Failed to fetch seller gas balance:", err);
        }
      }
      gateway = targetAddress ? await getGatewayBalances(targetAddress) : { total: "0.00", available: "0.00", withdrawing: "0.00", withdrawable: "0.00" };

      if (targetAddress) {
        statsCache.set(cacheKey, {
          walletBalance,
          gasBalance,
          gateway,
          timestamp: now,
        });
      }
    }

    // Filter heartbeats by creator address
    const filteredHeartbeats = heartbeats.filter(hb => 
      !targetAddress || (hb as any).creatorAddress?.toLowerCase() === targetAddress.toLowerCase()
    );

    // Filter withdrawals by creator address
    const filteredWithdrawals = withdrawals.filter(w => 
      !targetAddress ||
      w.creatorAddress?.toLowerCase() === targetAddress.toLowerCase() ||
      w.destinationAddress.toLowerCase() === targetAddress.toLowerCase()
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

// Endpoint: get global platform-wide statistics for the landing page
app.get("/api/global-stats", (req, res) => {
  const owncastHeartbeats = heartbeats.filter(hb => !hb.id.startsWith("hb_jf_") && !hb.id.startsWith("hb_pt_"));

  const liveRevenue = owncastHeartbeats.reduce((acc, curr) => acc + parseFloat(curr.amount), 0) +
                      jellyfinSessions.reduce((acc, curr) => acc + curr.totalSettledAmount, 0) +
                      peertubeTransactions.reduce((acc, curr) => acc + curr.amount, 0);

  const liveWatchTimeSeconds = (owncastHeartbeats.length * 2) +
                               jellyfinSessions.reduce((acc, curr) => {
                                 const watchTime = curr.isActive 
                                   ? Math.floor((Date.now() - curr.startTimestamp) / 1000)
                                   : Math.floor((curr.lastSettleTimestamp - curr.startTimestamp) / 1000);
                                 return acc + (watchTime > 0 ? watchTime : 0);
                               }, 0);

  const totalSessions = historicalStreamCount + jellyfinSessions.length + peertubeTransactions.length;

  res.json({
    totalRevenueProcessed: liveRevenue.toFixed(6),
    totalStreamingSessions: totalSessions,
    totalWatchTime: liveWatchTimeSeconds
  });
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
  const { burnIntent, signature, feeBurnIntent, feeSignature, destinationChain } = req.body;
  if (!burnIntent || !signature || !destinationChain) {
    return res.status(400).json({ error: "burnIntent, signature, and destinationChain are required" });
  }

  const withdrawalId = `w_${Date.now()}`;
  const spec = burnIntent.spec;
  const amountAtomic = spec.value;
  const recipientBytes32 = spec.destinationRecipient;
  const sourceDepositorBytes32 = spec.sourceDepositor;
  const recipient = "0x" + recipientBytes32.slice(-40); // extract address from 32-byte pad
  const creatorAddress = sourceDepositorBytes32 ? "0x" + sourceDepositorBytes32.slice(-40) : recipient;
  
  const amountFormatted = (parseFloat(amountAtomic) / 1_000_000).toFixed(6);

  const transferItems: Array<{ burnIntent: any; signature: string }> = [{ burnIntent, signature }];
  let platformFee: { amount: string; recipient: string; spec: any } | undefined;

  if (feeBurnIntent || feeSignature) {
    if (!feeBurnIntent || !feeSignature) {
      return res.status(400).json({ error: "feeBurnIntent and feeSignature must be supplied together" });
    }
    const feeSpec = feeBurnIntent.spec;
    if (!feeSpec || !feeSpec.destinationRecipient || !feeSpec.sourceDepositor) {
      return res.status(400).json({ error: "Invalid feeBurnIntent format" });
    }
    const feeRecipient = "0x" + feeSpec.destinationRecipient.slice(-40);
    const feeCreatorAddress = "0x" + feeSpec.sourceDepositor.slice(-40);
    if (feeRecipient.toLowerCase() !== PLATFORM_WALLET.toLowerCase()) {
      return res.status(400).json({ error: "Invalid platform fee recipient address" });
    }
    if (feeCreatorAddress.toLowerCase() !== creatorAddress.toLowerCase()) {
      return res.status(400).json({ error: "Platform fee source depositor must match the creator withdrawal source" });
    }

    platformFee = {
      amount: (parseFloat(feeSpec.value) / 1_000_000).toFixed(6),
      recipient: feeRecipient,
      spec: feeSpec,
    };
    transferItems.push({ burnIntent: feeBurnIntent, signature: feeSignature });
  }

  withdrawals.push({
    id: withdrawalId,
    amount: amountFormatted,
    destinationChain,
    destinationAddress: recipient,
    creatorAddress,
    platformFee,
    status: "submitted",
    txHash: null,
    timestamp: new Date().toISOString(),
  });
  saveState();


  try {
    const GATEWAY_API_TESTNET = "https://gateway-api-testnet.circle.com/v1";

    const requiredAtomic = transferItems.reduce((acc, item) => {
      const value = BigInt(normalizeAtomicField(item.burnIntent?.spec?.value, "burnIntent.spec.value"));
      const maxFee = BigInt(normalizeAtomicField(item.burnIntent?.maxFee, "burnIntent.maxFee"));
      return acc + value + maxFee;
    }, 0n);
    const gatewayBalance = await getGatewayBalances(creatorAddress as `0x${string}`);
    const availableAtomic = parseUnits(gatewayBalance.available || "0", 6);
    if (availableAtomic < requiredAtomic) {
      throw validationError(`Insufficient Gateway available balance for withdrawal. Available ${formatUnits(availableAtomic, 6)} USDC, required ${formatUnits(requiredAtomic, 6)} USDC including Gateway max fees.`);
    }

    // Submit net payout and platform fee together. One Gateway attestation prevents partial fee-only burns.
    console.log(`[CastPay] Submitting Gateway withdrawal ${withdrawalId} for ${creatorAddress}: ${formatUnits(requiredAtomic, 6)} USDC including max fees`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(`${GATEWAY_API_TESTNET}/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(
          transferItems,
          (_, v) => typeof v === "bigint" ? v.toString() : v
        )
      });
    } catch (error: any) {
      if (error?.name === "AbortError") {
        throw validationError("Circle Gateway transfer request timed out before an attestation was returned. Please retry the withdrawal.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const result = await response.json();
    if (!response.ok || result.success === false || result.error || !result.attestation || !result.signature) {
      throw new Error(
        `Circle Gateway API error: ${result.message || result.error || JSON.stringify(result)}`
      );
    }

    const readyIdx = withdrawals.findIndex(w => w.id === withdrawalId);
    if (readyIdx !== -1) {
      withdrawals[readyIdx].status = "ready_to_claim";
      withdrawals[readyIdx].attestation = result.attestation;
      withdrawals[readyIdx].circleSignature = result.signature;
      withdrawals[readyIdx].gatewaySubmittedAt = new Date().toISOString();
      saveState();
    }
    console.log(`[CastPay] Gateway withdrawal ${withdrawalId} is ready to claim on ${destinationChain}`);

    res.json({
      success: true,
      attestation: result.attestation,
      circleSignature: result.signature,
      amount: amountFormatted,
      destinationChain,
      recipient,
      withdrawalId,
    });
  } catch (error: any) {
    console.error("Withdrawal error:", error);
    const idx = withdrawals.findIndex(w => w.id === withdrawalId);
    if (idx !== -1) {
      withdrawals[idx].status = "failed";
      saveState();
    }
    const statusCode = typeof error?.statusCode === "number" ? error.statusCode : 500;
    res.status(statusCode).json({ error: "Withdrawal failed", details: error?.message || String(error) });
  }
});

// Endpoint: get list of platform fees
app.get("/api/platform-fees", (req, res) => {
  res.json(platformFees);
});

// Endpoint: confirm claim of platform fee
app.post("/api/platform-fees/claim", (req, res) => {
  const { id, txHash } = req.body;
  if (!id || !txHash) {
    return res.status(400).json({ error: "id and txHash are required" });
  }
  const idx = platformFees.findIndex(f => f.id === id);
  if (idx !== -1) {
    platformFees[idx].status = "claimed";
    platformFees[idx].txHash = txHash;
    saveState();
    console.log(`[CastPay Platform Fee] Claim for fee ${id} confirmed with tx: ${txHash}`);
    return res.json({ success: true });
  }
  res.status(404).json({ error: "Platform fee record not found" });
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
    const platformFee = withdrawals[idx].platformFee;
    if (platformFee && !platformFees.some((fee) => fee.withdrawalId === id)) {
      platformFees.push({
        id: `fee_${Date.now()}`,
        amount: platformFee.amount,
        destinationChain: withdrawals[idx].destinationChain,
        recipient: platformFee.recipient,
        spec: platformFee.spec,
        attestation: null,
        circleSignature: null,
        status: "claimed",
        txHash,
        timestamp: new Date().toISOString(),
        withdrawalId: id,
      });
      console.log(`[CastPay Platform Fee] Fee ${platformFee.amount} USDC claimed in withdrawal ${id}`);
    }
    statsCache.delete((withdrawals[idx].creatorAddress || "").toLowerCase());
    saveState();
    console.log(`[CastPay] Withdrawal ${id} confirmed with tx: ${txHash}`);
    return res.json({ success: true });
  }
  res.status(404).json({ error: "Withdrawal not found" });
});

// Endpoint: Heartbeat payment receiver (conforms to x402 specification)
app.post("/api/heartbeat", async (req, res) => {
  const paymentSignature = req.headers["payment-signature"] as string;
  const creatorAddress = (req.query.creator as string) || sellerAddress;

  if (!creatorAddress) {
    return res.status(400).json({ error: "creator query parameter or default sellerAddress is required" });
  }

  // Find the creator stream
  const stream = activeStreams.find(
    (s) => s.creatorAddress.toLowerCase() === creatorAddress.toLowerCase()
  );

  const rate = stream ? stream.ratePerSecond : currentRatePerSecond;
  const targetSellerAddress = stream ? stream.creatorAddress : sellerAddress;

  // Heartbeat is sent every 2 seconds
  const heartbeatInterval = 2;
  // Calculate base and fee in atomic units (6 decimals for USDC)
  const baseAmountAtomic = Math.round(rate * heartbeatInterval * 1_000_000);
  const feeAmountAtomic = Math.round(baseAmountAtomic * 0.015); // 1.5% fee
  const amountAtomic = baseAmountAtomic + feeAmountAtomic;
  const heartbeatPrice = (amountAtomic / 1_000_000).toFixed(6);

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
        saveState();
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

// Endpoint: Jellyfin Webhook receiver sidecar
app.post("/api/webhooks/jellyfin", async (req, res) => {
  const { NotificationType, SessionId, ItemName, ItemId, UserId, viewerAddress, creatorAddress, ratePerMinute } = req.body;

  if (!NotificationType || !SessionId) {
    return res.status(400).json({ error: "NotificationType and SessionId are required" });
  }

  console.log(`[CastPay Jellyfin Webhook] Event: ${NotificationType} | Session: ${SessionId} | Item: ${ItemName}`);

  // Fallbacks for addresses if not supplied (to support direct standard webhook testing)
  const targetViewer = viewerAddress || "0x0A5483f454051BCC0609A488ae6F536E5DAAc684"; // default buyer/viewer address
  const targetCreator = creatorAddress || "0xB24B46b9aE72361f12dc5454D9B031608b23Ec79"; // default seller/creator address
  const targetRate = typeof ratePerMinute === "number" ? ratePerMinute : 0.006; // default: 0.006 USDC/minute (0.0001 USDC/sec)

  let session = jellyfinSessions.find(s => s.sessionId === SessionId);

  if (NotificationType === "PlaybackStart") {
    // Start new session
    if (session) {
      session.isActive = true;
      session.startTimestamp = Date.now();
      session.lastSettleTimestamp = Date.now();
    } else {
      jellyfinSessions.push({
        sessionId: SessionId,
        viewerAddress: targetViewer,
        creatorAddress: targetCreator,
        ratePerMinute: targetRate,
        startTimestamp: Date.now(),
        lastSettleTimestamp: Date.now(),
        totalSettledAmount: 0,
        itemName: ItemName || "Unknown VOD Content",
        isActive: true
      });
    }
    saveState();
    return res.json({ success: true, message: "Playback session started" });
  }

  if (!session) {
    // If progress/stop arrives but session wasn't started, create it now
    session = {
      sessionId: SessionId,
      viewerAddress: targetViewer,
      creatorAddress: targetCreator,
      ratePerMinute: targetRate,
      startTimestamp: Date.now() - 60000, // pretend it started 1 min ago
      lastSettleTimestamp: Date.now() - 60000,
      totalSettledAmount: 0,
      itemName: ItemName || "Unknown VOD Content",
      isActive: true
    };
    jellyfinSessions.push(session);
  }

  if (NotificationType === "PlaybackProgress") {
    // Calculate elapsed minutes since last settlement
    const now = Date.now();
    const elapsedMinutes = Math.floor((now - session.lastSettleTimestamp) / 60000);

    if (elapsedMinutes >= 1) {
      const settleAmount = elapsedMinutes * session.ratePerMinute;
      session.totalSettledAmount += settleAmount;
      session.lastSettleTimestamp = now;

      // Simulate the on-chain transfer recording
      const fakeTxHash = "0x" + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
      
      // Also register a heartbeat event to show in log tables
      heartbeats.push({
        id: `hb_jf_${Date.now()}`,
        payer: session.viewerAddress,
        amount: settleAmount.toString(),
        timestamp: new Date().toISOString(),
        txHash: fakeTxHash
      });

      console.log(`[CastPay Jellyfin Webhook] Settled ${settleAmount} USDC for session ${SessionId} | Tx: ${fakeTxHash}`);
    }
    saveState();
    return res.json({ success: true, message: "Playback progress processed", totalSettled: session.totalSettledAmount });
  }

  if (NotificationType === "PlaybackStop") {
    // Finalize session
    const now = Date.now();
    const elapsedSeconds = Math.max(0, Math.floor((now - session.lastSettleTimestamp) / 1000));
    
    // Settle remaining pro-rated portion of the minute (down to second resolution)
    if (elapsedSeconds > 0) {
      const proRatedAmount = (elapsedSeconds / 60) * session.ratePerMinute;
      session.totalSettledAmount += proRatedAmount;
      
      const fakeTxHash = "0x" + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
      heartbeats.push({
        id: `hb_jf_${Date.now()}`,
        payer: session.viewerAddress,
        amount: proRatedAmount.toFixed(6),
        timestamp: new Date().toISOString(),
        txHash: fakeTxHash
      });
    }

    session.isActive = false;
    session.lastSettleTimestamp = now;
    saveState();
    return res.json({ success: true, message: "Playback session stopped", totalSettled: session.totalSettledAmount });
  }

  res.status(400).json({ error: "Unsupported NotificationType" });
});

// Endpoint: PeerTube Payments Plugin receiver webhook
app.post("/api/webhooks/peertube", async (req, res) => {
  const { event, viewerAddress, creatorAddress, amount, videoId, videoTitle } = req.body;

  if (!event || !viewerAddress || !creatorAddress || !amount) {
    return res.status(400).json({ error: "event, viewerAddress, creatorAddress, and amount are required" });
  }

  console.log(`[CastPay PeerTube Webhook] Event: ${event} | Video: ${videoTitle || videoId} | Amount: ${amount} USDC`);

  // Record transaction event
  const txHash = "0x" + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  
  const txRecord: PeerTubeTransaction = {
    id: `pt_${Date.now()}`,
    viewerAddress,
    creatorAddress,
    amount: parseFloat(amount),
    videoId: videoId || "unknown",
    videoTitle: videoTitle || "Unknown PeerTube Video",
    timestamp: new Date().toISOString(),
    txHash
  };

  peertubeTransactions.push(txRecord);

  // Add a heartbeat record so it shows up in explorer listings
  heartbeats.push({
    id: `hb_pt_${Date.now()}`,
    payer: viewerAddress,
    amount: amount.toString(),
    timestamp: new Date().toISOString(),
    txHash
  });

  saveState();
  res.json({ success: true, txHash, record: txRecord });
});


// Endpoint: register active stream
app.post("/api/streams/register", (req, res) => {
  const { address, name, streamUrl, rate, platform } = req.body;
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
  } else {
    historicalStreamCount++; // New stream session registered!
  }

  activeStreams.push({
    creatorAddress: address,
    creatorName: name,
    streamUrl,
    ratePerSecond: rate,
    isActive: true,
    platform: platform || "owncast",
  });

  saveState();
  console.log(`[CastPay] Creator stream registered: ${name} (${address}) -> ${streamUrl} at ${rate} USDC/sec [Platform: ${platform || "owncast"}]`);
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
    saveState();
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
      platform: s.platform || "owncast",
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

  // Verify that the viewer has a settled heartbeat in the last 60 seconds for this creator
  const lastSeen = activeViewersMap.get(`${viewerAddress.toLowerCase()}_${creatorAddress.toLowerCase()}`);
  const now = Date.now();
  if (!lastSeen || now - lastSeen > 60000) {
    return res.status(402).json({ error: "Payment Required - No active heartbeat found in the last 60 seconds" });
  }

  // Resolve base upstream URL
  const lastSlash = stream.streamUrl.lastIndexOf("/");
  const baseUrl = stream.streamUrl.substring(0, lastSlash + 1);
  const creatorFilename = stream.streamUrl.substring(lastSlash + 1);

  let resolvedFilePath = filePath;
  // If the player requests index.m3u8, map it to the creator's actual playlist filename (e.g. stream.m3u8)
  if (filePath === "index.m3u8") {
    resolvedFilePath = creatorFilename;
  }

  const targetUrl = baseUrl + resolvedFilePath;
  const cacheKey = `${creatorAddress.toLowerCase()}_${resolvedFilePath}`;

  // 1. If it's a playlist file (.m3u8), check playlist cache first
  if (resolvedFilePath.endsWith(".m3u8")) {
    const cached = playlistCache.get(cacheKey);
    const nowMs = Date.now();

    if (cached && (nowMs - cached.timestamp < PLAYLIST_CACHE_TTL_MS)) {
      if (cached.contentType) {
        res.setHeader("Content-Type", cached.contentType);
      }
      res.setHeader("Access-Control-Allow-Origin", "*");

      const lines = cached.text.split("\n");
      const modifiedLines = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const separator = trimmed.includes("?") ? "&" : "?";
          return `${trimmed}${separator}viewer=${encodeURIComponent(viewerAddress)}`;
        }
        return line;
      });
      return res.send(modifiedLines.join("\n"));
    }
  } else {
    // 2. If it's a segment file, check segment cache first to avoid hitting Owncast
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

  // 3. Cache miss: fetch from upstream
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

    if (resolvedFilePath.endsWith(".m3u8")) {
      const text = await upstreamRes.text();
      
      // Cache the raw playlist
      playlistCache.set(cacheKey, {
        text,
        contentType,
        timestamp: Date.now(),
      });

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
      segmentCache.set(cacheKey, {
        buffer: nodeBuffer,
        contentType,
        timestamp: Date.now(),
      });

      res.send(nodeBuffer);
    }
  } catch (err) {
    console.error(`[CastPay Proxy] Error proxying ${resolvedFilePath}:`, err);
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
