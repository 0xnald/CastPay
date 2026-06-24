import { useState, useEffect, useRef } from "react";
import { 
  Play, 
  Pause, 
  Wallet, 
  Settings, 
  ArrowUpRight, 
  Tv, 
  RefreshCw, 
  Plus, 
  TrendingUp, 
  ExternalLink,
  Activity,
  UserCheck,
  Copy,
  LogOut,
  BookOpen,
  Film,
  Lock,
  Layers
} from "lucide-react";
import Hls from "hls.js";
import { GatewayClient, CHAIN_CONFIGS, SupportedChainName, BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createPublicClient, createWalletClient, custom, http, fallback, formatUnits, parseUnits, erc20Abi, pad, zeroAddress, maxUint256 } from "viem";
import { arcTestnet } from "viem/chains";

// Monkeypatch EIP-3009 signature generation to add a 1-day (86400s) buffer to the validBefore timestamp.
// This ensures that the signed signature's validity exceeds the accepted maxTimeoutSeconds by 24 hours,
// absorbing network latency and client-side clock skew, thereby avoiding "authorization_validity_too_short".
const patchPayload = (original: any) => {
  if (!original) return original;
  return async function(this: any, x402Version: any, requirements: any) {
    const modifiedRequirements = {
      ...requirements,
      maxTimeoutSeconds: (requirements.maxTimeoutSeconds || 0) + 86400,
    };
    return await original.call(this, x402Version, modifiedRequirements);
  };
};

if (GatewayClient && GatewayClient.prototype) {
  (GatewayClient.prototype as any).createPaymentPayload = patchPayload((GatewayClient.prototype as any).createPaymentPayload);
}
if (BatchEvmScheme && BatchEvmScheme.prototype) {
  (BatchEvmScheme.prototype as any).createPaymentPayload = patchPayload((BatchEvmScheme.prototype as any).createPaymentPayload);
}

const BACKEND_URL = "http://localhost:3001";
const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";
const ARC_TESTNET_RPC = (typeof process !== "undefined" && process.env && process.env.RPC) || "https://rpc.testnet.arc.network";
const PLATFORM_WALLET = "0xDF04435F24bC101FCDc05Dc88D2911194De1F9FA";

const GATEWAY_MINTER_ABI = [
  {
    name: "gatewayMint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "attestationPayload", type: "bytes" },
      { name: "signature", type: "bytes" }
    ],
    outputs: []
  }
] as const;

const GATEWAY_WALLET_ABI = [
  {
    name: "depositFor",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "depositor", type: "address" },
      { name: "value", type: "uint256" }
    ],
    outputs: []
  }
] as const;

const padAddress = (addr: string) => {
  return pad(addr.toLowerCase() as `0x${string}`, { size: 32 });
};

const getExplorerTxLink = (chainName: string, txHash: string) => {
  if (!txHash) return "";
  switch(chainName) {
    case "arcTestnet": return `https://testnet.arcscan.app/tx/${txHash}`;
    case "baseSepolia": return `https://sepolia.basescan.org/tx/${txHash}`;
    case "sepolia": return `https://sepolia.etherscan.io/tx/${txHash}`;
    case "arbitrumSepolia": return `https://sepolia.arbiscan.io/tx/${txHash}`;
    case "optimismSepolia": return `https://sepolia-optimism.etherscan.io/tx/${txHash}`;
    case "avalancheFuji": return `https://testnet.snowtrace.io/tx/${txHash}`;
    case "polygonAmoy": return `https://amoy.polygonscan.com/tx/${txHash}`;
    default: return `https://testnet.arcscan.app/tx/${txHash}`;
  }
};

const createBurnIntent = (
  fromConfig: any,
  toConfig: any,
  value: bigint,
  depositor: string,
  recipient: string,
  maxFee: bigint
) => {
  const randomBytes = new Uint8Array(32);
  window.crypto.getRandomValues(randomBytes);
  const salt = "0x" + Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('') as `0x${string}`;

  return {
    maxBlockHeight: maxUint256,
    maxFee,
    spec: {
      version: 1,
      sourceDomain: fromConfig.domain,
      destinationDomain: toConfig.domain,
      sourceContract: padAddress(fromConfig.gatewayWallet),
      destinationContract: padAddress(toConfig.gatewayMinter),
      sourceToken: padAddress(fromConfig.usdc),
      destinationToken: padAddress(toConfig.usdc),
      sourceDepositor: padAddress(depositor),
      destinationRecipient: padAddress(recipient),
      sourceSigner: padAddress(depositor),
      destinationCaller: padAddress(zeroAddress),
      value,
      salt,
      hookData: "0x" as `0x${string}`
    }
  };
};

const switchNetwork = async (
  chainId: number,
  chainName: string,
  rpcUrl: string,
  nativeCurrency: any,
  blockExplorer: string
) => {
  if (!(window as any).ethereum) return;
  const chainIdHex = "0x" + chainId.toString(16);
  try {
    await (window as any).ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  } catch (switchError: any) {
    if (switchError.code === 4902) {
      try {
        await (window as any).ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: chainIdHex,
            chainName,
            rpcUrls: [rpcUrl],
            nativeCurrency,
            blockExplorerUrls: [blockExplorer],
          }],
        });
      } catch (addError: any) {
        throw new Error(`Failed to add network ${chainName}: ${addError.message}`);
      }
    } else {
      throw switchError;
    }
  }
};

const formatWatchTime = (seconds: number) => {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ${seconds % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
};

export default function App() {
  const [activeTab, setActiveTab] = useState<"landing" | "viewer" | "creator">("landing");
  
  // App States
  const [isPlaying, setIsPlaying] = useState(false);
  const [streamRate, setStreamRate] = useState(0.0001); // USDC per second
  const [backendStatus, setBackendStatus] = useState<"online" | "offline">("offline");
  
  // MetaMask Connection States
  const [connectedAddress, setConnectedAddress] = useState<string>("");
  const [connectedChainId, setConnectedChainId] = useState<number | null>(null);

  // Ephemeral Viewer Wallet States
  const [viewerKey, setViewerKey] = useState<string>(() => {
    return localStorage.getItem("castpay_viewer_key") || "";
  });
  const [viewerAddress, setViewerAddress] = useState("");
  const [viewerWalletBalance, setViewerWalletBalance] = useState("0.00");
  const [viewerGatewayBalance, setViewerGatewayBalance] = useState("0.00");
  const [depositAmount, setDepositAmount] = useState("0.50");
  const [isDepositing, setIsDepositing] = useState(false);
  const [isFunding, setIsFunding] = useState(false);

  const [creatorStats, setCreatorStats] = useState({
    activeViewers: 0,
    totalReceived: "0.000000",
    rate: 0.0001,
    sellerAddress: "0x0000000000000000000000000000000000000000",
    walletBalance: "0.00",
    gasBalance: "0.00",
    gateway: { total: "0.00", available: "0.00", withdrawing: "0.00", withdrawable: "0.00" },
    heartbeats: [] as any[],
    withdrawals: [] as any[],
  });
  
  const [newRate, setNewRate] = useState("0.0001");
  const [withdrawAmount, setWithdrawAmount] = useState("0.10");
  const [withdrawChain, setWithdrawChain] = useState("arcTestnet");
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [withdrawAddress, setWithdrawAddress] = useState("");
  const [isRegisteringCreator, setIsRegisteringCreator] = useState(false);

  // Multi-tenant streaming states
  const [streamsList, setStreamsList] = useState<Array<{ creatorAddress: string; creatorName: string; ratePerSecond: number; platform?: string }>>([]);
  const [selectedCreator, setSelectedCreator] = useState<{ creatorAddress: string; creatorName: string; ratePerSecond: number; platform?: string } | null>(null);
  const [hasLoadedStreams, setHasLoadedStreams] = useState(false);
  
  // Creator console broadcaster states
  const [creatorNameInput, setCreatorNameInput] = useState("");
  const [owncastUrlInput, setOwncastUrlInput] = useState("https://demo.owncast.online/hls/stream.m3u8");
  const [isStreamActive, setIsStreamActive] = useState(false);
  const [platformType, setPlatformType] = useState<"owncast" | "jellyfin" | "peertube">("owncast");
  const [jellyfinItemName, setJellyfinItemName] = useState("Big Buck Bunny (VOD)");
  const [jellyfinRatePerMinute, setJellyfinRatePerMinute] = useState("0.006");
  const [peertubeVideoTitle, setPeertubeVideoTitle] = useState("Sintel (Federated Video)");
  const [peertubeAmount, setPeertubeAmount] = useState("0.05");

  // VOD Simulation States
  const [jellyfinPlayState, setJellyfinPlayState] = useState<"stopped" | "playing">("stopped");
  const [jellyfinSessionId, setJellyfinSessionId] = useState<string | null>(null);
  const [jellyfinLogs, setJellyfinLogs] = useState<Array<{ time: string; msg: string; type: "info" | "success" | "warn" }>>([]);
  const [jellyfinMinutesWatched, setJellyfinMinutesWatched] = useState(0);

  const [peertubePlayState, setPeertubePlayState] = useState<"locked" | "playing">("locked");
  const [peertubeLogs, setPeertubeLogs] = useState<Array<{ time: string; msg: string; type: "info" | "success" | "warn" }>>([]);



  // Refs & Particle States
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const heartbeatIntervalRef = useRef<any>(null);
  const gatewayClientRef = useRef<GatewayClient | null>(null);
  const publicClientRef = useRef<any>(null);

  const getPublicClient = () => {
    if (!publicClientRef.current) {
      publicClientRef.current = createPublicClient({
        chain: arcTestnet,
        transport: fallback([
          http(ARC_TESTNET_RPC),
          http("https://5042002.rpc.thirdweb.com")
        ]),
      });
    }
    return publicClientRef.current;
  };

  const getGatewayClient = () => {
    if (!viewerKey) return null;
    if (!gatewayClientRef.current || (gatewayClientRef.current as any)._viewerKeyUsed !== viewerKey) {
      const client = new GatewayClient({
        chain: "arcTestnet",
        privateKey: viewerKey as `0x${string}`,
        rpcUrl: "https://5042002.rpc.thirdweb.com",
      });
      (client as any)._viewerKeyUsed = viewerKey;
      gatewayClientRef.current = client;
    }
    return gatewayClientRef.current;
  };

  const [particles, setParticles] = useState<Array<{ id: number; text: string; x: number; y: number }>>([]);
  const [recentViewerPayments, setRecentViewerPayments] = useState<Array<{ id: string; amount: string; time: string; success: boolean; txHash?: string | null }>>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [showWalletDropdown, setShowWalletDropdown] = useState(false);

  const addJellyfinLog = (msg: string, type: "info" | "success" | "warn" = "info") => {
    const time = new Date().toLocaleTimeString();
    setJellyfinLogs(prev => [...prev, { time, msg, type }].slice(-20));
  };

  const addPeerTubeLog = (msg: string, type: "info" | "success" | "warn" = "info") => {
    const time = new Date().toLocaleTimeString();
    setPeertubeLogs(prev => [...prev, { time, msg, type }].slice(-20));
  };

  const triggerJellyfinWebhook = async (
    notificationType: "PlaybackStart" | "PlaybackProgress" | "PlaybackStop",
    creatorAddress: string,
    rateSec: number
  ) => {
    if (!connectedAddress) {
      setErrorMsg("Please connect your MetaMask wallet first.");
      return;
    }

    let currentSessionId = jellyfinSessionId;
    if (notificationType === "PlaybackStart") {
      currentSessionId = "jf_sess_" + Math.random().toString(36).substr(2, 9);
      setJellyfinSessionId(currentSessionId);
      setJellyfinPlayState("playing");
      setJellyfinMinutesWatched(0);
      setJellyfinLogs([]);
      addJellyfinLog(`🎬 Jellyfin Playback Started for Session: ${currentSessionId}`, "info");
    }

    if (!currentSessionId) {
      addJellyfinLog("⚠️ No active playback session to update.", "warn");
      return;
    }

    try {
      addJellyfinLog(`📡 Emitting Jellyfin Webhook event: ${notificationType}...`, "info");
      const res = await fetch(`${BACKEND_URL}/api/webhooks/jellyfin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          NotificationType: notificationType,
          SessionId: currentSessionId,
          ItemName: jellyfinItemName || "Big Buck Bunny (VOD)",
          ItemId: "jellyfin_item_12345",
          UserId: "jellyfin_user_abcde",
          viewerAddress: connectedAddress,
          creatorAddress: creatorAddress,
          ratePerMinute: rateSec * 60
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (notificationType === "PlaybackProgress") {
          setJellyfinMinutesWatched(prev => prev + 1);
          addJellyfinLog(`✅ PlaybackProgress processed. Settle triggered. (Total Settled: ${data.totalSettled?.toFixed(4)} USDC)`, "success");
          
          const id = Date.now() + Math.random();
          setParticles(prev => [...prev, { id, text: `+$${(rateSec * 60).toFixed(4)} USDC (Jellyfin)`, x: 45 + Math.random() * 10, y: 70 }]);
          setTimeout(() => {
            setParticles(prev => prev.filter(p => p.id !== id));
          }, 2000);
        } else if (notificationType === "PlaybackStop") {
          setJellyfinPlayState("stopped");
          setJellyfinSessionId(null);
          addJellyfinLog(`🏁 Jellyfin Playback Stopped. Final pro-rated settlement processed. (Total Session Earnings: ${data.totalSettled?.toFixed(4)} USDC)`, "success");
        } else {
          addJellyfinLog(`✅ PlaybackStart registered against Circle Gateway pre-authorization.`, "success");
        }
        fetchBackendStats();
      } else {
        const data = await res.json();
        addJellyfinLog(`❌ Webhook failed: ${data.error || "Unknown error"}`, "warn");
      }
    } catch (e: any) {
      addJellyfinLog(`❌ Network error sending webhook: ${e.message}`, "warn");
    }
  };

  const triggerPeerTubeWebhook = async (creatorAddress: string, amountVal: number) => {
    if (!connectedAddress) {
      setErrorMsg("Please connect your MetaMask wallet first.");
      return;
    }

    try {
      addPeerTubeLog(`📡 Emitting PeerTube Payments Webhook...`, "info");
      const res = await fetch(`${BACKEND_URL}/api/webhooks/peertube`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "video.purchase",
          viewerAddress: connectedAddress,
          creatorAddress: creatorAddress,
          amount: amountVal,
          videoId: "peertube_video_98765",
          videoTitle: peertubeVideoTitle || "Sintel (Federated Video)"
        })
      });

      if (res.ok) {
        const data = await res.json();
        setPeertubePlayState("playing");
        addPeerTubeLog(`✅ PeerTube purchase webhook settled! Tx: ${data.txHash.slice(0, 10)}...`, "success");
        addPeerTubeLog(`🔓 Video content unlocked. Enjoy playback!`, "success");
        
        const id = Date.now() + Math.random();
        setParticles(prev => [...prev, { id, text: `+$${amountVal.toFixed(3)} USDC (PeerTube)`, x: 45 + Math.random() * 10, y: 70 }]);
        setTimeout(() => {
          setParticles(prev => prev.filter(p => p.id !== id));
        }, 2000);

        fetchBackendStats();
      } else {
        const data = await res.json();
        addPeerTubeLog(`❌ Webhook failed: ${data.error || "Unknown error"}`, "warn");
      }
    } catch (e: any) {
      addPeerTubeLog(`❌ Network error sending webhook: ${e.message}`, "warn");
    }
  };

  const [globalStats, setGlobalStats] = useState({
    totalRevenueProcessed: "1548.245300",
    totalStreamingSessions: 42,
    totalWatchTime: 142850
  });

  // Initialize/retrieve ephemeral private key
  useEffect(() => {
    if (!viewerKey) {
      const newKey = generatePrivateKey();
      setViewerKey(newKey);
      localStorage.setItem("castpay_viewer_key", newKey);
    }
  }, [viewerKey]);

  // Compute viewer address
  useEffect(() => {
    if (viewerKey) {
      try {
        const account = privateKeyToAccount(viewerKey as `0x${string}`);
        setViewerAddress(account.address);
      } catch (e) {
        setViewerAddress("");
      }
    }
  }, [viewerKey]);

  // Fetch global platform-wide statistics
  useEffect(() => {
    const fetchGlobalStats = async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/global-stats`);
        if (res.ok) {
          const data = await res.json();
          setGlobalStats(data);
        }
      } catch (err) {
        console.warn("Failed to fetch global stats:", err);
      }
    };
    fetchGlobalStats();
    const interval = setInterval(fetchGlobalStats, 5000);
    return () => clearInterval(interval);
  }, []);

  // Dropdown reference and click-outside handler
  const dropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowWalletDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  // Fetch stats periodically
  useEffect(() => {
    fetchBackendStats();
    const interval = setInterval(fetchBackendStats, 3000);
    return () => clearInterval(interval);
  }, [activeTab, connectedAddress, selectedCreator?.creatorAddress]);

  // Fetch active streams list periodically
  useEffect(() => {
    const fetchActiveStreams = async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/streams`);
        if (res.ok) {
          const data = await res.json();
          setStreamsList(data);
          
          if (selectedCreator) {
            const stillLive = data.find(
              (s: any) => s.creatorAddress.toLowerCase() === selectedCreator.creatorAddress.toLowerCase()
            );
            if (!stillLive) {
              if (hasLoadedStreams) {
                setSelectedCreator(null);
                setIsPlaying(false);
                setErrorMsg("The creator has stopped their live stream.");
              }
            } else {
              // Only update state if fields have changed, protecting reference stability
              if (
                stillLive.ratePerSecond !== selectedCreator.ratePerSecond ||
                stillLive.creatorName !== selectedCreator.creatorName ||
                stillLive.creatorAddress !== selectedCreator.creatorAddress
              ) {
                setSelectedCreator(stillLive);
              }
            }
          }
          setHasLoadedStreams(true);
        }
      } catch (err) {
        console.warn("Failed to fetch active streams:", err);
      }
    };

    fetchActiveStreams();
    const interval = setInterval(fetchActiveStreams, 3000);
    return () => clearInterval(interval);
  }, [selectedCreator?.creatorAddress, hasLoadedStreams]);

  // Handle URL query parameters for shareable creator link on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const creatorParam = params.get("creator");
    if (creatorParam) {
      setSelectedCreator({
        creatorAddress: creatorParam,
        creatorName: "Direct Link Creator",
        ratePerSecond: 0.0001
      });
      setActiveTab("viewer");
    }
  }, []);

  // Check if connected creator is already live on backend
  useEffect(() => {
    if (connectedAddress && streamsList.length > 0) {
      const active = streamsList.find(s => s.creatorAddress.toLowerCase() === connectedAddress.toLowerCase());
      if (active) {
        setIsStreamActive(true);
        setCreatorNameInput(active.creatorName);
        setNewRate(active.ratePerSecond.toString());
      }
    }
  }, [connectedAddress, streamsList]);

  // Auto-connect MetaMask wallet if already authorized
  useEffect(() => {
    const checkMetaMaskConnected = async () => {
      if (typeof window !== "undefined" && (window as any).ethereum) {
        try {
          const accounts = await (window as any).ethereum.request({ method: "eth_accounts" });
          if (accounts && accounts.length > 0) {
            setConnectedAddress(accounts[0]);
            const chainIdHex = await (window as any).ethereum.request({ method: "eth_chainId" });
            setConnectedChainId(parseInt(chainIdHex, 16));
            
            // Listen for changes
            (window as any).ethereum.on("accountsChanged", (accs: string[]) => {
              if (accs.length > 0) {
                setConnectedAddress(accs[0]);
              } else {
                setConnectedAddress("");
              }
            });

            (window as any).ethereum.on("chainChanged", (hexId: string) => {
              setConnectedChainId(parseInt(hexId, 16));
            });
          }
        } catch (e) {
          console.warn("Failed to check MetaMask connection:", e);
        }
      }
    };
    checkMetaMaskConnected();
  }, []);

  // Fetch viewer balance periodically
  useEffect(() => {
    if (viewerAddress) {
      fetchViewerBalances();
      const interval = setInterval(fetchViewerBalances, 5000);
      return () => clearInterval(interval);
    }
  }, [viewerAddress]);

  // Video stream mounting
  useEffect(() => {
    if (videoRef.current) {
      if (isPlaying && selectedCreator) {
        const proxyStreamUrl = `${BACKEND_URL}/api/stream/${selectedCreator.creatorAddress}/index.m3u8?viewer=${viewerAddress}`;
        if (Hls.isSupported()) {
          const hls = new Hls();
          hls.loadSource(proxyStreamUrl);
          hls.attachMedia(videoRef.current);
          hlsRef.current = hls;
          videoRef.current.play().catch(err => console.log("Video auto play prevented", err));
        } else if (videoRef.current.canPlayType("application/vnd.apple.mpegurl")) {
          videoRef.current.src = proxyStreamUrl;
          videoRef.current.play().catch(err => console.log("Video auto play prevented", err));
        }
      } else {
        if (hlsRef.current) {
          hlsRef.current.destroy();
          hlsRef.current = null;
        }
        videoRef.current.pause();
        videoRef.current.src = "";
      }
    }
  }, [isPlaying, selectedCreator?.creatorAddress, viewerAddress]);

  // Heartbeat loop when streaming
  useEffect(() => {
    if (isPlaying && selectedCreator) {
      // Start heartbeat every 2 seconds
      heartbeatIntervalRef.current = setInterval(() => sendHeartbeat(), 2000);
    } else {
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
    }
    return () => {
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }
    };
  }, [isPlaying, viewerKey, streamRate, selectedCreator?.creatorAddress]);

  const fetchBackendStats = async () => {
    try {
      let url = `${BACKEND_URL}/api/stats`;
      if (activeTab === "creator" && connectedAddress) {
        url += `?creator=${connectedAddress}`;
      } else if (activeTab === "viewer" && selectedCreator) {
        url += `?creator=${selectedCreator.creatorAddress}`;
      }
      
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setCreatorStats(data);
        setStreamRate(data.rate);
        setBackendStatus("online");
      } else {
        setBackendStatus("offline");
      }
    } catch (e) {
      setBackendStatus("offline");
    }
  };

  const fetchViewerBalances = async () => {
    if (!viewerAddress) return;
    try {
      const publicClient = getPublicClient();

      // Wallet balance
      const balance = await publicClient.readContract({
        address: ARC_TESTNET_USDC,
        abi: [
          {
            constant: true,
            inputs: [{ name: "_owner", type: "address" }],
            name: "balanceOf",
            outputs: [{ name: "balance", type: "uint256" }],
            type: "function",
          },
        ],
        functionName: "balanceOf",
        args: [viewerAddress as `0x${string}`],
      });
      setViewerWalletBalance(parseFloat(formatUnits(balance as bigint, 6)).toFixed(4));

      // Gateway balance
      const gateway = getGatewayClient();
      if (!gateway) return;
      const balances = await gateway.getBalances();
      setViewerGatewayBalance(parseFloat(balances.gateway.formattedAvailable).toFixed(4));
    } catch (err) {
      console.warn("Failed to fetch viewer balances:", err);
    }
  };

  const sendHeartbeat = async (creatorAddrOverride?: string) => {
    const creatorAddr = creatorAddrOverride || selectedCreator?.creatorAddress;
    if (!viewerKey || !creatorAddr) return;
    try {
      const gateway = getGatewayClient();
      if (!gateway) return;

      const start = Date.now();
      const creator = streamsList.find(s => s.creatorAddress.toLowerCase() === creatorAddr.toLowerCase());
      const rate = creator ? creator.ratePerSecond : streamRate;
      const heartbeatPrice = (rate * 2).toFixed(6);

      // Call gateway.pay which handles 402 challenge response automatically
      const result = await gateway.pay(`${BACKEND_URL}/api/heartbeat?creator=${creatorAddr}`, { method: "POST" });
      const duration = Date.now() - start;
      console.log(`Heartbeat settled in ${duration}ms, tx: ${result.transaction}`);

      // Add particle
      triggerParticle(`+$${heartbeatPrice} USDC`);

      // Update viewer balances
      fetchViewerBalances();

      // Log locally
      setRecentViewerPayments(prev => [
        {
          id: `tx_${Date.now()}`,
          amount: heartbeatPrice,
          time: new Date().toLocaleTimeString(),
          success: true,
          txHash: result.transaction
        },
        ...prev.slice(0, 9)
      ]);
    } catch (err) {
      console.error("Heartbeat billing failed:", err);
      setErrorMsg(`Payment failed: ${(err as Error).message}`);
      setIsPlaying(false); // Stop playback on billing failure

      const creator = streamsList.find(s => s.creatorAddress.toLowerCase() === creatorAddr.toLowerCase());
      const rate = creator ? creator.ratePerSecond : streamRate;
      const heartbeatPrice = (rate * 2).toFixed(6);

      setRecentViewerPayments(prev => [
        {
          id: `tx_${Date.now()}`,
          amount: heartbeatPrice,
          time: new Date().toLocaleTimeString(),
          success: false
        },
        ...prev.slice(0, 9)
      ]);
      throw err;
    }
  };

  const handleStartPlaying = async () => {
    if (!selectedCreator) return;
    setErrorMsg("");
    setSuccessMsg("");
    try {
      setSuccessMsg("Authorizing stream access with initial heartbeat...");
      await sendHeartbeat(selectedCreator.creatorAddress);
      setIsPlaying(true);
      setSuccessMsg("Stream authorized successfully!");
    } catch (err: any) {
      setErrorMsg(`Failed to authorize stream: ${err.message || err.toString()}`);
    }
  };

  const triggerParticle = (text: string) => {
    const id = Date.now() + Math.random();
    const x = 50 + (Math.random() * 60 - 30); // Center around player
    const y = 80;
    setParticles(prev => [...prev, { id, text, x, y }]);
    setTimeout(() => {
      setParticles(prev => prev.filter(p => p.id !== id));
    }, 1500);
  };

  const handleDeposit = async () => {
    if (!connectedAddress) {
      setErrorMsg("Please connect your MetaMask wallet first.");
      return;
    }
    if (connectedChainId !== 5042002) {
      await ensureArcNetwork();
      return;
    }
    if (isDepositing || !depositAmount) return;
    setErrorMsg("");
    setSuccessMsg("");
    setIsDepositing(true);
    try {
      const amountVal = parseUnits(depositAmount, 6);
      const walletClient = createWalletClient({
        account: connectedAddress as `0x${string}`,
        chain: arcTestnet,
        transport: custom((window as any).ethereum)
      });
      const publicClient = createPublicClient({
        chain: arcTestnet,
        transport: fallback([
          http(ARC_TESTNET_RPC),
          http("https://5042002.rpc.thirdweb.com")
        ])
      });

      // Check MetaMask USDC balance
      const balance = await publicClient.readContract({
        address: ARC_TESTNET_USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [connectedAddress as `0x${string}`]
      });

      if (balance < amountVal) {
        throw new Error(`Insufficient MetaMask USDC balance. Have: ${formatUnits(balance, 6)} USDC, Need: ${depositAmount} USDC`);
      }

      // Check Allowance
      const gatewayWalletAddress = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
      const allowance = await publicClient.readContract({
        address: ARC_TESTNET_USDC,
        abi: erc20Abi,
        functionName: "allowance",
        args: [connectedAddress as `0x${string}`, gatewayWalletAddress]
      });

      if (allowance < amountVal) {
        setSuccessMsg("Approving USDC spending in MetaMask...");
        const approveTx = await walletClient.writeContract({
          address: ARC_TESTNET_USDC,
          abi: erc20Abi,
          functionName: "approve",
          args: [gatewayWalletAddress, amountVal]
        });
        setSuccessMsg(`Approval pending: ${approveTx.slice(0, 15)}...`);
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
      }

      setSuccessMsg("Depositing USDC into Gateway in MetaMask...");
      const depositTx = await walletClient.writeContract({
        address: gatewayWalletAddress,
        abi: GATEWAY_WALLET_ABI,
        functionName: "depositFor",
        args: [ARC_TESTNET_USDC, viewerAddress as `0x${string}`, amountVal]
      });
      setSuccessMsg(`Deposit transaction submitted: ${depositTx.slice(0, 15)}...`);
      await publicClient.waitForTransactionReceipt({ hash: depositTx });
      setSuccessMsg(`Deposit successful! Tx: ${depositTx.slice(0, 15)}...`);
      fetchViewerBalances();
    } catch (err: any) {
      console.error("Deposit failed:", err);
      setErrorMsg(`Deposit failed: ${err.message || err.toString()}`);
    } finally {
      setIsDepositing(false);
    }
  };


  const handleWithdraw = async () => {
    if (!connectedAddress) {
      setErrorMsg("Please connect your MetaMask wallet first.");
      return;
    }
    if (creatorStats.sellerAddress === "0x0000000000000000000000000000000000000000" || !creatorStats.sellerAddress) {
      setErrorMsg("Creator address is not registered. Please register first.");
      return;
    }
    if (connectedAddress.toLowerCase() !== creatorStats.sellerAddress.toLowerCase()) {
      setErrorMsg(`Connected wallet (${connectedAddress.slice(0, 8)}...) does not match registered creator wallet (${creatorStats.sellerAddress.slice(0, 8)}...). Please switch accounts in MetaMask.`);
      return;
    }
    if (isWithdrawing) return;
    setErrorMsg("");
    setSuccessMsg("");
    setIsWithdrawing(true);
    try {
      // 1. Ensure we are on Arc Testnet to initiate the burn intent signature
      if (connectedChainId !== 5042002) {
        setSuccessMsg("Switching to Arc Testnet to sign withdrawal...");
        await ensureArcNetwork();
        // Wait briefly for MetaMask state update
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Calculate Platform Fee (1.5%) and Net withdrawal amount
      const withdrawAmountAtomic = parseUnits(withdrawAmount, 6);
      const feeAmountAtomic = (withdrawAmountAtomic * 15n) / 1015n; // 1.5% fee split from gross (1.015)
      const netAmountAtomic = withdrawAmountAtomic - feeAmountAtomic;

      const recipient = withdrawAddress || creatorStats.sellerAddress;
      const maxFeeVal = parseUnits("2.01", 6); // default max fee 2.01 USDC

      const fromConfig = CHAIN_CONFIGS.arcTestnet;
      const toConfig = CHAIN_CONFIGS[withdrawChain as SupportedChainName];
      if (!toConfig) {
        throw new Error(`Unsupported destination chain: ${withdrawChain}`);
      }

      // 2. Construct the BurnIntent payloads
      // A. Net BurnIntent to the creator
      const burnIntent = createBurnIntent(
        fromConfig,
        toConfig,
        netAmountAtomic,
        creatorStats.sellerAddress,
        recipient,
        maxFeeVal
      );

      // B. Fee BurnIntent to the platform (if fee > 0)
      let feeBurnIntent = null;
      if (feeAmountAtomic > 0n) {
        feeBurnIntent = createBurnIntent(
          fromConfig,
          toConfig,
          feeAmountAtomic,
          creatorStats.sellerAddress,
          PLATFORM_WALLET,
          maxFeeVal
        );
      }

      const walletClient = createWalletClient({
        account: connectedAddress as `0x${string}`,
        chain: arcTestnet,
        transport: custom((window as any).ethereum)
      });

      const typesConfig = {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" }
        ],
        TransferSpec: [
          { name: "version", type: "uint32" },
          { name: "sourceDomain", type: "uint32" },
          { name: "destinationDomain", type: "uint32" },
          { name: "sourceContract", type: "bytes32" },
          { name: "destinationContract", type: "bytes32" },
          { name: "sourceToken", type: "bytes32" },
          { name: "destinationToken", type: "bytes32" },
          { name: "sourceDepositor", type: "bytes32" },
          { name: "destinationRecipient", type: "bytes32" },
          { name: "sourceSigner", type: "bytes32" },
          { name: "destinationCaller", type: "bytes32" },
          { name: "value", type: "uint256" },
          { name: "salt", type: "bytes32" },
          { name: "hookData", type: "bytes" }
        ],
        BurnIntent: [
          { name: "maxBlockHeight", type: "uint256" },
          { name: "maxFee", type: "uint256" },
          { name: "spec", type: "TransferSpec" }
        ]
      } as const;

      // 3. Prompt user to sign Net EIP-712 BurnIntent typed data via MetaMask
      setSuccessMsg(`Please sign Net withdrawal authorization (${(parseFloat(formatUnits(netAmountAtomic, 6))).toFixed(4)} USDC) in MetaMask...`);
      const signature = await walletClient.signTypedData({
        domain: { name: "GatewayWallet", version: "1" },
        types: typesConfig,
        primaryType: "BurnIntent",
        message: burnIntent
      });

      // 4. Prompt user to sign Platform Fee EIP-712 BurnIntent typed data if applicable
      let feeSignature = null;
      if (feeBurnIntent) {
        setSuccessMsg(`Please sign Platform Fee authorization (${(parseFloat(formatUnits(feeAmountAtomic, 6))).toFixed(4)} USDC) in MetaMask...`);
        // Wait briefly between signatures for user friendliness
        await new Promise((resolve) => setTimeout(resolve, 800));
        feeSignature = await walletClient.signTypedData({
          domain: { name: "GatewayWallet", version: "1" },
          types: typesConfig,
          primaryType: "BurnIntent",
          message: feeBurnIntent
        });
      }

      // 5. POST both signatures to the backend sidecar
      setSuccessMsg("Submitting withdrawal signatures to CastPay server...");
      const res = await fetch(`${BACKEND_URL}/api/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          burnIntent,
          signature,
          feeBurnIntent,
          feeSignature,
          destinationChain: withdrawChain,
        }, (_, v) => typeof v === "bigint" ? v.toString() : v),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || data.details || "Withdrawal failed at gateway proxy");
      }

      const withdrawData = await res.json();
      const { attestation, circleSignature, withdrawalId } = withdrawData;

      // 5. If destination chain is different, switch MetaMask to destination chain
      const destChainId = toConfig.chain.id;
      if (connectedChainId !== destChainId) {
        setSuccessMsg(`Switching network to ${toConfig.chain.name} for claiming...`);
        await switchNetwork(
          destChainId,
          toConfig.chain.name,
          toConfig.rpcUrl || toConfig.chain.rpcUrls.default.http[0],
          toConfig.chain.nativeCurrency || { name: "USDC", symbol: "USDC", decimals: 18 },
          toConfig.chain.blockExplorers?.default?.url || ""
        );
        // Wait briefly for network switch to complete in MetaMask
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // 6. Execute the gatewayMint contract write on destination chain via MetaMask
      setSuccessMsg(`Submitting claim transaction on ${toConfig.chain.name}...`);
      const destWallet = createWalletClient({
        account: connectedAddress as `0x${string}`,
        chain: toConfig.chain,
        transport: custom((window as any).ethereum)
      });
      const destPublic = createPublicClient({
        chain: toConfig.chain,
        transport: custom((window as any).ethereum)
      });

      const mintTx = await destWallet.writeContract({
        address: toConfig.gatewayMinter,
        abi: GATEWAY_MINTER_ABI,
        functionName: "gatewayMint",
        args: [attestation, circleSignature]
      });

      setSuccessMsg(`Claim submitted: ${mintTx.slice(0, 15)}... Waiting for receipt...`);
      await destPublic.waitForTransactionReceipt({ hash: mintTx });

      // 7. Confirm withdrawal complete with the backend sidecar
      await fetch(`${BACKEND_URL}/api/withdraw/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: withdrawalId, txHash: mintTx }),
      });

      setSuccessMsg(`Withdrawal complete and claimed! Tx: ${mintTx.slice(0, 15)}...`);
      fetchBackendStats();
    } catch (err: any) {
      console.error("Withdrawal error:", err);
      setErrorMsg(`Withdrawal failed: ${err.message || err.toString()}`);
    } finally {
      setIsWithdrawing(false);
    }
  };

  const handleRegisterCreator = async () => {
    if (isRegisteringCreator) return;
    if (!connectedAddress) {
      setErrorMsg("Please connect your MetaMask wallet first.");
      return;
    }

    setIsRegisteringCreator(true);
    setErrorMsg("");
    setSuccessMsg("");
    try {
      const res = await fetch(`${BACKEND_URL}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: connectedAddress,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setSuccessMsg(`Creator wallet registered successfully! Address: ${data.sellerAddress}`);
        fetchBackendStats();
      } else {
        const data = await res.json();
        setErrorMsg(`Creator registration failed: ${data.error}`);
      }
    } catch (e) {
      setErrorMsg("Creator registration request failed.");
    } finally {
      setIsRegisteringCreator(false);
    }
  };

  const handleGoLive = async () => {
    if (!connectedAddress) {
      setErrorMsg("Please connect your MetaMask wallet first.");
      return;
    }
    if (!creatorNameInput.trim()) {
      setErrorMsg("Please enter your display name.");
      return;
    }
    
    let billingRate = 0;
    let targetStreamUrl = owncastUrlInput;
    let targetName = creatorNameInput;

    if (platformType === "owncast") {
      if (!owncastUrlInput.trim()) {
        setErrorMsg("Please enter your Owncast HLS stream URL.");
        return;
      }
      billingRate = parseFloat(newRate);
      if (isNaN(billingRate) || billingRate <= 0) {
        setErrorMsg("Please enter a valid positive billing rate.");
        return;
      }
    } else if (platformType === "jellyfin") {
      if (!jellyfinItemName.trim()) {
        setErrorMsg("Please enter the Movie/Show title.");
        return;
      }
      const rateMin = parseFloat(jellyfinRatePerMinute);
      if (isNaN(rateMin) || rateMin <= 0) {
        setErrorMsg("Please enter a valid positive rate per minute.");
        return;
      }
      billingRate = rateMin / 60; // pro-rate to per second
      targetName = `${creatorNameInput} (${jellyfinItemName})`;
      targetStreamUrl = `http://localhost:3001/api/webhooks/jellyfin/simulated`;
    } else if (platformType === "peertube") {
      if (!peertubeVideoTitle.trim()) {
        setErrorMsg("Please enter the Video title.");
        return;
      }
      const flatAmt = parseFloat(peertubeAmount);
      if (isNaN(flatAmt) || flatAmt <= 0) {
        setErrorMsg("Please enter a valid positive PeerTube amount.");
        return;
      }
      billingRate = flatAmt; 
      targetName = `${creatorNameInput} (${peertubeVideoTitle})`;
      targetStreamUrl = `http://localhost:3001/api/webhooks/peertube/simulated`;
    }

    setIsRegisteringCreator(true);
    setErrorMsg("");
    setSuccessMsg("");
    try {
      // 1. Register wallet with the backend
      const regRes = await fetch(`${BACKEND_URL}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: connectedAddress }),
      });
      if (!regRes.ok) {
        const data = await regRes.json();
        throw new Error(data.error || "Failed to register creator wallet.");
      }

      // 2. Register stream in the active registry
      const streamRes = await fetch(`${BACKEND_URL}/api/streams/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: connectedAddress,
          name: targetName,
          streamUrl: targetStreamUrl,
          rate: billingRate,
          platform: platformType,
        }),
      });

      if (streamRes.ok) {
        setSuccessMsg(`Congratulations! You are now live as ${targetName}!`);
        setIsStreamActive(true);
        fetchBackendStats();
      } else {
        const data = await streamRes.json();
        throw new Error(data.error || "Failed to register live stream.");
      }
    } catch (e: any) {
      setErrorMsg(e.message || "Failed to go live.");
    } finally {
      setIsRegisteringCreator(false);
    }
  };

  const handleStopLive = async () => {
    if (!connectedAddress) return;
    setErrorMsg("");
    setSuccessMsg("");
    setIsRegisteringCreator(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/streams/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: connectedAddress }),
      });
      if (res.ok) {
        setSuccessMsg("You have stopped your stream and gone offline.");
        setIsStreamActive(false);
        fetchBackendStats();
      } else {
        const data = await res.json();
        setErrorMsg(`Failed to stop stream: ${data.error}`);
      }
    } catch (err) {
      setErrorMsg("Failed to stop stream.");
    } finally {
      setIsRegisteringCreator(false);
    }
  };

  const connectWallet = async () => {
    if (typeof window === "undefined" || !(window as any).ethereum) {
      setErrorMsg("MetaMask or compatible Web3 wallet not found in browser.");
      return;
    }
    try {
      setErrorMsg("");
      const accounts = await (window as any).ethereum.request({ method: "eth_requestAccounts" });
      if (accounts && accounts.length > 0) {
        setConnectedAddress(accounts[0]);
        
        // Fetch chainId
        const chainIdHex = await (window as any).ethereum.request({ method: "eth_chainId" });
        const chainId = parseInt(chainIdHex, 16);
        setConnectedChainId(chainId);
        
        setSuccessMsg(`Wallet connected: ${accounts[0]}`);

        // Listen for changes
        (window as any).ethereum.on("accountsChanged", (accs: string[]) => {
          if (accs.length > 0) {
            setConnectedAddress(accs[0]);
          } else {
            setConnectedAddress("");
          }
        });

        (window as any).ethereum.on("chainChanged", (hexId: string) => {
          setConnectedChainId(parseInt(hexId, 16));
        });

        // Ensure we are on Arc Testnet
        if (chainId !== 5042002) {
          await ensureArcNetwork();
        }
      }
    } catch (err: any) {
      setErrorMsg(`Failed to connect wallet: ${err.message}`);
    }
  };

  const ensureArcNetwork = async () => {
    if (!(window as any).ethereum) return;
    try {
      await (window as any).ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x4ceca2" }], // 5042002 in hex is 0x4ceca2
      });
    } catch (switchError: any) {
      if (switchError.code === 4902) {
        try {
          await (window as any).ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: "0x4ceca2",
              chainName: "Arc Testnet",
              rpcUrls: ["https://rpc.testnet.arc.network"],
              nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
              blockExplorerUrls: ["https://testnet.arcscan.app"],
            }],
          });
        } catch (addError: any) {
          setErrorMsg(`Please manually add the Arc Testnet to your MetaMask: ${addError.message}`);
        }
      } else {
        setErrorMsg(`Failed to switch network: ${switchError.message}`);
      }
    }
  };

  const handleFaucetFund = async () => {
    if (isFunding) return;
    setErrorMsg("");
    setSuccessMsg("");
    setIsFunding(true);
    
    const target = connectedAddress || viewerAddress;
    setSuccessMsg(`Please fund address: ${target} using the Circle Faucet!`);
    window.open("https://faucet.circle.com/", "_blank");
    setIsFunding(false);
  };

  const handleResetWallet = () => {
    if (window.confirm("Are you sure you want to generate a new ephemeral wallet? This will discard your current key.")) {
      const newKey = generatePrivateKey();
      setViewerKey(newKey);
      localStorage.setItem("castpay_viewer_key", newKey);
      setSuccessMsg("New ephemeral wallet generated.");
    }
  };

  // Generate simple SVG line chart from heartbeat payments
  const renderEarningsChart = () => {
    const points = creatorStats.heartbeats.slice(-15).reverse();
    if (points.length < 2) {
      return (
        <div className="h-40 flex items-center justify-center text-secondary border border-dashed border-gold-muted rounded-lg">
          Not enough historical payment events to chart yet
        </div>
      );
    }

    const width = 500;
    const height = 150;
    const padding = 20;

    let accum = 0;
    const chartData = points.map((p, i) => {
      accum += parseFloat(p.amount);
      return { x: i, y: accum };
    });

    const maxY = Math.max(...chartData.map(d => d.y)) || 0.01;
    const minY = 0;

    const scaleX = (x: number) => padding + (x / (chartData.length - 1)) * (width - padding * 2);
    const scaleY = (y: number) => height - padding - ((y - minY) / (maxY - minY)) * (height - padding * 2);

    let pathD = `M ${scaleX(chartData[0].x)} ${scaleY(chartData[0].y)}`;
    for (let i = 1; i < chartData.length; i++) {
      pathD += ` L ${scaleX(chartData[i].x)} ${scaleY(chartData[i].y)}`;
    }

    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-40 overflow-visible">
        <defs>
          <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#c5a880" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#c5a880" stopOpacity="0.0" />
          </linearGradient>
        </defs>
        {/* Grids */}
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="rgba(197, 168, 128, 0.15)" />
        <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="rgba(197, 168, 128, 0.05)" />
        {/* Area fill */}
        <path
          d={`${pathD} L ${scaleX(chartData[chartData.length - 1].x)} ${height - padding} L ${scaleX(chartData[0].x)} ${height - padding} Z`}
          fill="url(#chartGrad)"
        />
        {/* Stroke Line */}
        <path d={pathD} fill="none" stroke="#c5a880" strokeWidth="2.5" />
        {/* Data points */}
        {chartData.map((d, i) => (
          <circle
            key={i}
            cx={scaleX(d.x)}
            cy={scaleY(d.y)}
            r="4"
            fill="#0a0907"
            stroke="#c5a880"
            strokeWidth="2"
          />
        ))}
      </svg>
    );
  };

  const renderLandingPage = () => {
    return (
      <div className="relative">
        <div className="stripe-bg"></div>
        
        {/* Hero Section */}
        <div className="py-20 text-center max-w-4xl mx-auto flex flex-col items-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-gold-accent/20 bg-gold-accent/5 text-xs text-gold-accent mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-gold-accent animate-pulse"></span>
            CastPay is live on Arc Testnet
          </div>
          
          <h1 className="hero-heading">
            Continuous payment infrastructure for live video streaming
          </h1>
          
          <p className="text-secondary text-base sm:text-lg mb-10 max-w-2xl font-normal leading-relaxed">
            CastPay enables pay-per-second content monetization. Viewers pay micro-amounts in real time using non-custodial gateway wallets, while creators withdraw earnings instantly to any chain.
          </p>
          
          <div className="flex flex-wrap gap-4 justify-center">
            <button 
              onClick={() => setActiveTab("viewer")}
              className="btn-gold py-3 px-6 text-sm"
            >
              <Tv className="w-4 h-4 fill-current" />
              Launch Viewer Portal
            </button>
            <button 
              onClick={() => setActiveTab("creator")}
              className="btn-outline py-3 px-6 text-sm"
            >
              <Settings className="w-4 h-4" />
              Creator Console
            </button>
          </div>
        </div>

        {/* Global Statistics Section */}
        <div className="stats-vertical-container">
          <div className="stats-item">
            <span className="stats-item-title">Total Revenue Processed</span>
            <div className="stats-item-value">{parseFloat(globalStats.totalRevenueProcessed).toFixed(4)} USDC</div>
            <span className="stats-item-subtitle">Live on-chain settlements</span>
          </div>

          <div className="stats-item">
            <span className="stats-item-title">Total Streaming Sessions</span>
            <div className="stats-item-value">{globalStats.totalStreamingSessions} Sessions</div>
            <span className="stats-item-subtitle">Active and historical streamers</span>
          </div>

          <div className="stats-item">
            <span className="stats-item-title">Total Watch Time</span>
            <div className="stats-item-value">{formatWatchTime(globalStats.totalWatchTime)}</div>
            <span className="stats-item-subtitle">Accumulated stream duration</span>
          </div>
        </div>


        {/* GitBook-style Developer Footer */}
        <footer className="gitbook-footer">
          <div className="footer-grid">
            {/* Left Column: Brand & Docs Card */}
            <div className="footer-brand-col">
              <div className="flex items-center gap-2">
                <img 
                  src="/logo.png" 
                  alt="CastPay Logo" 
                  className="footer-logo-img" 
                />
                <span className="font-serif text-xl tracking-wide font-medium">CastPay</span>
              </div>
              <p className="text-xs text-secondary leading-relaxed">
                Secure, non-custodial pay-per-second content monetization powered by Circle Gateway and Arc L1.
              </p>
              <a 
                href="https://github.com/circlefin" 
                target="_blank" 
                rel="noopener noreferrer" 
                className="docs-card"
              >
                <div>
                  <div className="docs-card-title">
                    <BookOpen className="w-4 h-4 text-gold-accent" />
                    Explore Docs
                  </div>
                  <div className="docs-card-desc">Explore developer integration guides</div>
                </div>
                <ArrowUpRight className="w-4 h-4 text-secondary" />
              </a>
            </div>

            {/* Products Column */}
            <div>
              <h5 className="footer-col-title">Products</h5>
              <ul className="footer-links-list">
                <li>
                  <button onClick={() => setActiveTab("viewer")} className="footer-link-item bg-transparent border-0 p-0 cursor-pointer">
                    Viewer Portal
                  </button>
                </li>
                <li>
                  <button onClick={() => setActiveTab("creator")} className="footer-link-item bg-transparent border-0 p-0 cursor-pointer">
                    Creator Console
                  </button>
                </li>
                <li><span className="footer-link-item opacity-50 cursor-default">Cross-Chain Payouts</span></li>
              </ul>
            </div>

            {/* Protocol Column */}
            <div>
              <h5 className="footer-col-title">Protocol</h5>
              <ul className="footer-links-list">
                <li><span className="footer-link-item opacity-50 cursor-default">GatewayWallet Contract</span></li>
                <li><span className="footer-link-item opacity-50 cursor-default">Cross-Chain Relayer</span></li>
                <li>
                  <a href="https://testnet.arcscan.app" target="_blank" rel="noopener noreferrer" className="footer-link-item">
                    Arc Testnet Scan
                  </a>
                </li>
                <li>
                  <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer" className="footer-link-item">
                    Circle Faucet
                  </a>
                </li>
              </ul>
            </div>

            {/* Developers Column */}
            <div>
              <h5 className="footer-col-title">Developers</h5>
              <ul className="footer-links-list">
                <li><span className="footer-link-item opacity-50 cursor-default">API Reference</span></li>
                <li><span className="footer-link-item opacity-50 cursor-default">EIP-3009 Spec</span></li>
                <li>
                  <a href="https://github.com/circlefin" target="_blank" rel="noopener noreferrer" className="footer-link-item">
                    GitHub Repository
                  </a>
                </li>
              </ul>
            </div>

            {/* Socials Column */}
            <div>
              <h5 className="footer-col-title">Socials</h5>
              <ul className="footer-links-list">
                <li><a href="https://twitter.com" target="_blank" rel="noopener noreferrer" className="footer-link-item">X / Twitter</a></li>
                <li><a href="https://discord.com" target="_blank" rel="noopener noreferrer" className="footer-link-item">Discord</a></li>
                <li><a href="https://telegram.org" target="_blank" rel="noopener noreferrer" className="footer-link-item">Telegram</a></li>
              </ul>
            </div>
          </div>

          {/* Bottom Toolbar */}
          <div className="footer-bottom-toolbar">
            <div className="flex items-center">
              {/* Status Dot Indicator relocated from Header */}
              <div className="footer-status-indicator">
                <span className={`status-dot ${backendStatus === "online" ? "active" : "inactive"}`}></span>
                <span className="text-[11px] uppercase tracking-wider font-semibold">
                  {backendStatus === "online" ? "System Online" : "System Offline"}
                </span>
              </div>
            </div>
            <div className="text-[11px] text-secondary font-medium">
              © 2026 CastPay Labs. Built for streamers.
            </div>
          </div>
        </footer>
      </div>
    );
  };

  return (
    <div className="min-h-screen pb-12">
      {/* Upper Navigation Bar */}
      <header className="border-b border-gold-muted bg-[#0c0a08]/90 sticky top-0 z-50 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div 
            onClick={() => setActiveTab("landing")}
            className="flex items-center gap-3 cursor-pointer select-none group"
          >
            <img 
              src="/logo.png" 
              alt="CastPay Logo" 
              style={{ width: "32px", height: "32px", borderRadius: "6px", objectFit: "contain" }}
              className="border border-gold-muted/30 group-hover:border-gold-accent transition-all"
            />
            <div>
              <span className="font-serif text-2xl tracking-wide font-medium group-hover:text-gold-bright transition-all">CastPay</span>
              <span className="text-[10px] text-secondary border border-gold-muted px-1.5 py-0.5 rounded ml-2 uppercase font-medium">Arc L1</span>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            {connectedAddress ? (
              <div className="relative" ref={dropdownRef}>
                <button 
                  onClick={() => setShowWalletDropdown(!showWalletDropdown)}
                  className="text-xs border border-gold-muted hover:border-gold-bright px-3 py-1.5 rounded-lg font-mono text-gold-bright flex items-center gap-1.5 transition-all bg-[#0f0e0b]"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-[#4ade80]"></span>
                  {connectedAddress.slice(0, 6)}...{connectedAddress.slice(-4)}
                </button>
                {showWalletDropdown && (
                  <div className="wallet-dropdown-panel">
                    <div className="text-[10px] uppercase font-semibold text-secondary mb-2">Connected Wallet</div>
                    <div className="text-xs font-mono text-gold-bright break-all mb-4 select-all bg-[#0a0907] p-2 rounded border border-gold-muted/10">
                      {connectedAddress}
                    </div>
                    <div className="flex flex-col gap-1">
                      <button 
                        onClick={() => {
                          navigator.clipboard.writeText(connectedAddress);
                          setSuccessMsg("Wallet address copied to clipboard!");
                          setShowWalletDropdown(false);
                        }}
                        className="wallet-dropdown-item"
                      >
                        <Copy className="w-3.5 h-3.5 text-gold-accent" />
                        Copy Address
                      </button>
                      <button 
                        onClick={() => {
                          setConnectedAddress("");
                          setConnectedChainId(null);
                          setShowWalletDropdown(false);
                          setSuccessMsg("Wallet disconnected.");
                        }}
                        className="wallet-dropdown-item disconnect"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        Disconnect Wallet
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <button 
                onClick={connectWallet}
                className="text-xs btn-gold px-3 py-1.5 rounded-lg flex items-center gap-1.5"
              >
                <Wallet className="w-3.5 h-3.5" />
                Connect Wallet
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Feedback Messages */}
      <div className="max-w-6xl mx-auto px-6 mt-4">
        {errorMsg && (
          <div className="p-4 bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg text-sm mb-4">
            {errorMsg}
          </div>
        )}
        {successMsg && (
          <div className="p-4 bg-blue-500/10 border border-blue-500/30 text-blue-300 rounded-lg text-sm mb-4">
            {successMsg}
          </div>
        )}
      </div>

      <main className="max-w-6xl mx-auto px-6 mt-4">
        {activeTab === "landing" ? (
          renderLandingPage()
        ) : activeTab === "viewer" ? (
          /* ========================================================================= */
          /* VIEWERS PORTAL TAB                                                       */
          /* ========================================================================= */
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left/Middle: Stream Player Card or Streamer Directory */}
            <div className="lg:col-span-2 flex flex-col gap-6">
              {selectedCreator ? (
                <div className="glass-panel overflow-hidden relative">
                  {/* Streaming Header bar */}
                  <div className="px-5 py-3.5 border-b border-gold-muted flex items-center justify-between bg-card-bg">
                    <div className="flex items-center gap-2">
                      <span className="pulse-dot bg-[#60a5fa]"></span>
                      <span className="text-sm font-semibold tracking-wide uppercase">
                        Watching: {selectedCreator.creatorName}
                      </span>
                    </div>
                    <button
                      onClick={() => {
                        setIsPlaying(false);
                        setSelectedCreator(null);
                      }}
                      className="text-xs text-gold-accent hover:text-gold-bright flex items-center gap-1 bg-transparent border-0 cursor-pointer"
                    >
                      ← Back to Directory
                    </button>
                  </div>

                  {/* Video container */}
                  {/* Video container */}
                  <div className="relative aspect-video bg-black flex items-center justify-center">
                    {/* Platform conditional rendering */}
                    {(!selectedCreator.platform || selectedCreator.platform === "owncast") ? (
                      isPlaying ? (
                        <video 
                          ref={videoRef}
                          className="w-full h-full object-contain"
                          controls={false}
                          playsInline
                        />
                      ) : (
                        <div className="flex flex-col items-center gap-4 text-center px-6">
                          <Tv className="w-12 h-12 text-gold-muted" />
                          <div>
                            <h3 className="font-serif text-2xl text-gold-accent">Pay-Per-Second Stream Gating</h3>
                            <p className="text-xs text-secondary max-w-sm mt-1">
                              Authorize streaming micropayments with your Gateway balance to watch <strong>{selectedCreator.creatorName}</strong>.
                            </p>
                          </div>
                        </div>
                      )
                    ) : selectedCreator.platform === "jellyfin" ? (
                      <div className="w-full h-full flex flex-col items-center justify-center p-6 bg-[#0a0908] relative overflow-hidden">
                        <div className="absolute top-4 left-4 flex items-center gap-2 text-gold-accent">
                          <Film className="w-4 h-4" />
                          <span className="text-[10px] uppercase tracking-widest font-semibold">Jellyfin VOD Portal</span>
                        </div>
                        {jellyfinPlayState === "playing" ? (
                          <div className="flex flex-col items-center gap-4 text-center">
                            <div className="w-12 h-12 rounded-full border-4 border-gold-accent border-t-transparent animate-spin flex items-center justify-center">
                              <Film className="w-5 h-5 text-gold-bright" />
                            </div>
                            <div>
                              <h4 className="font-serif text-xl text-gold-bright">Streaming Movie Selection</h4>
                              <p className="text-xs text-secondary mt-1">Simulated Session: <strong className="text-gold-accent">{jellyfinSessionId?.slice(0, 10)}...</strong></p>
                              <p className="text-xs text-secondary mt-0.5">Watch Time: <strong className="text-gold-accent">{jellyfinMinutesWatched} min</strong></p>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center gap-4 text-center">
                            <Tv className="w-12 h-12 text-secondary opacity-40" />
                            <div>
                              <h4 className="font-serif text-xl text-secondary">Playback Stopped / Gated</h4>
                              <p className="text-xs text-secondary mt-1">Settle rate: {(selectedCreator.ratePerSecond * 60).toFixed(4)} USDC/min</p>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      /* PeerTube Simulator */
                      <div className="w-full h-full flex flex-col items-center justify-center p-6 bg-[#0a0908] relative overflow-hidden">
                        <div className="absolute top-4 left-4 flex items-center gap-2 text-gold-accent">
                          <Layers className="w-4 h-4" />
                          <span className="text-[10px] uppercase tracking-widest font-semibold">PeerTube Payments Plugin</span>
                        </div>
                        {peertubePlayState === "playing" ? (
                          <div className="flex flex-col items-center gap-4 text-center">
                            <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                              <Play className="w-6 h-6 fill-current animate-pulse" />
                            </div>
                            <div>
                              <h4 className="font-serif text-lg text-gold-bright">Sintel - Premium Playback Active</h4>
                              <p className="text-xs text-secondary mt-1">Unlocked via CastPay monero/USDC gateway</p>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center gap-4 text-center px-8">
                            <Lock className="w-12 h-12 text-[#f87171] opacity-70 mb-2" />
                            <div>
                              <h4 className="font-serif text-xl text-gold-bright">Federated Video Gated</h4>
                              <p className="text-xs text-secondary mt-1">Purchase flat rate: {selectedCreator.ratePerSecond.toFixed(2)} USDC to unlock</p>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Billing particles overlay */}
                    {particles.map(p => (
                      <div 
                        key={p.id}
                        className="particle"
                        style={{ left: `${p.x}%`, top: `${p.y}%` }}
                      >
                        {p.text}
                      </div>
                    ))}
                  </div>

                  {/* Player actions panel */}
                  <div className="p-5 flex flex-col sm:flex-row gap-4 justify-between items-center bg-[#0d0b09]">
                    {(!selectedCreator.platform || selectedCreator.platform === "owncast") && (
                      <>
                        <div className="text-xs text-secondary flex-grow">
                          <div>Rate: <strong className="text-gold-bright">{(selectedCreator.ratePerSecond * 1.015 * 2).toFixed(5)} USDC</strong> / 2s <span className="text-secondary text-[9px] font-normal">(incl. 1.5% fee)</span></div>
                          <div className="mt-0.5">Creator Wallet: <span className="font-mono">{selectedCreator.creatorAddress.slice(0, 10)}...{selectedCreator.creatorAddress.slice(-8)}</span></div>
                        </div>

                        <button
                          onClick={() => {
                            if (isPlaying) {
                              setIsPlaying(false);
                            } else {
                              handleStartPlaying();
                            }
                          }}
                          disabled={!viewerGatewayBalance || parseFloat(viewerGatewayBalance) <= 0}
                          className={`w-full sm:w-auto btn-gold px-6 ${isPlaying ? "bg-red-400 text-black hover:bg-red-300" : ""}`}
                        >
                          {isPlaying ? (
                            <>
                              <Pause className="w-4 h-4 fill-current" />
                              Pause Stream
                            </>
                          ) : (
                            <>
                              <Play className="w-4 h-4 fill-current" />
                              Pay & Watch
                            </>
                          )}
                        </button>
                      </>
                    )}

                    {selectedCreator.platform === "jellyfin" && (
                      <>
                        <div className="text-xs text-secondary flex-grow">
                          <div>Rate: <strong className="text-gold-bright">{(selectedCreator.ratePerSecond * 60 * 1.015).toFixed(4)} USDC</strong> / min <span className="text-secondary text-[9px] font-normal">(incl. 1.5% fee)</span></div>
                          <div className="mt-0.5 font-mono text-[10px]">Session: {jellyfinSessionId || "none"}</div>
                        </div>

                        <div className="flex gap-2 w-full sm:w-auto">
                          {jellyfinPlayState === "stopped" ? (
                            <button
                              onClick={() => triggerJellyfinWebhook("PlaybackStart", selectedCreator.creatorAddress, selectedCreator.ratePerSecond)}
                              disabled={!viewerGatewayBalance || parseFloat(viewerGatewayBalance) <= 0}
                              className="btn-gold text-xs px-4 py-2 flex-grow sm:flex-grow-0"
                            >
                              <Play className="w-3.5 h-3.5 fill-current" /> Play
                            </button>
                          ) : (
                            <>
                              <button
                                onClick={() => triggerJellyfinWebhook("PlaybackProgress", selectedCreator.creatorAddress, selectedCreator.ratePerSecond)}
                                className="btn-outline text-xs px-4 py-2 border-gold-accent text-gold-accent hover:text-gold-bright"
                              >
                                ⏩ Simulate 1 Min Watch
                              </button>
                              <button
                                onClick={() => triggerJellyfinWebhook("PlaybackStop", selectedCreator.creatorAddress, selectedCreator.ratePerSecond)}
                                className="btn-gold text-xs px-4 py-2 bg-red-500 text-black hover:bg-red-400"
                              >
                                <Pause className="w-3.5 h-3.5 fill-current" /> Stop
                              </button>
                            </>
                          )}
                        </div>
                      </>
                    )}

                    {selectedCreator.platform === "peertube" && (
                      <>
                        <div className="text-xs text-secondary flex-grow">
                          <div>Price: <strong className="text-gold-bright">{(selectedCreator.ratePerSecond * 1.015).toFixed(3)} USDC</strong> <span className="text-secondary text-[9px] font-normal">(incl. 1.5% fee)</span></div>
                          <div className="mt-0.5 font-mono text-[10px]">Status: {peertubePlayState}</div>
                        </div>

                        <div className="flex gap-2 w-full sm:w-auto">
                          {peertubePlayState === "locked" ? (
                            <button
                              onClick={() => triggerPeerTubeWebhook(selectedCreator.creatorAddress, selectedCreator.ratePerSecond)}
                              disabled={!viewerGatewayBalance || parseFloat(viewerGatewayBalance) <= 0}
                              className="btn-gold text-xs px-5 py-2"
                            >
                              🔓 Purchase & Unlock Video
                            </button>
                          ) : (
                            <button
                              onClick={() => setPeertubePlayState("locked")}
                              className="btn-outline text-xs px-5 py-2"
                            >
                              🔒 Re-Lock Content
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Simulation Logs Terminal */}
                  {selectedCreator.platform && selectedCreator.platform !== "owncast" && (
                    <div className="p-4 border-t border-gold-muted bg-[#050403] font-mono text-[10px] text-secondary">
                      <div className="flex justify-between items-center mb-2 border-b border-gold-muted/20 pb-1.5 text-gold-muted">
                        <span>Sidecar Webhook Activity Log</span>
                        <span className="text-[8px] uppercase tracking-widest bg-gold-accent/10 px-1 py-0.5 rounded text-gold-accent font-semibold">Terminal</span>
                      </div>
                      <div className="max-h-24 overflow-y-auto space-y-1 pr-1 font-mono leading-relaxed">
                        {selectedCreator.platform === "jellyfin" ? (
                          jellyfinLogs.length === 0 ? (
                            <span className="text-secondary/40 italic">Waiting for playback actions...</span>
                          ) : (
                            jellyfinLogs.map((log, idx) => (
                              <div key={idx} className={log.type === "success" ? "text-emerald-400" : log.type === "warn" ? "text-amber-400" : "text-secondary"}>
                                [{log.time}] {log.msg}
                              </div>
                            ))
                          )
                        ) : (
                          peertubeLogs.length === 0 ? (
                            <span className="text-secondary/40 italic">Waiting for purchase action...</span>
                          ) : (
                            peertubeLogs.map((log, idx) => (
                              <div key={idx} className={log.type === "success" ? "text-emerald-400" : log.type === "warn" ? "text-amber-400" : "text-secondary"}>
                                [{log.time}] {log.msg}
                              </div>
                            ))
                          )
                        )}
                      </div>
                    </div>
                  )}

                  
                  {/* Shareable link card */}
                  <div className="p-4 border-t border-gold-muted bg-[#0c0a08]/40 flex items-center justify-between">
                    <span className="text-[10px] uppercase font-semibold text-secondary">Share this Stream:</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-gold-muted select-all">
                        {`${window.location.origin}/?creator=${selectedCreator.creatorAddress}`}
                      </span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(`${window.location.origin}/?creator=${selectedCreator.creatorAddress}`);
                          setSuccessMsg("Shareable link copied to clipboard!");
                        }}
                        className="text-[10px] border border-gold-muted px-2 py-1 rounded hover:border-gold-accent text-gold-accent hover:text-gold-bright transition-all bg-[#0f0e0b]"
                      >
                        Copy Link
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="glass-panel p-6 flex flex-col gap-6">
                  <div>
                    <h3 className="font-serif text-2xl text-gold-accent">Live Streams Directory</h3>
                    <p className="text-xs text-secondary mt-1">Select a creator below to start watching their gated live stream on the big screen.</p>
                  </div>

                  {streamsList.length === 0 ? (
                    <div className="text-center py-12 border border-dashed border-gold-muted rounded-xl bg-[#0c0a08]/30">
                      <Tv className="w-12 h-12 text-gold-muted mx-auto mb-3" />
                      <p className="text-sm text-secondary">No creators are currently live.</p>
                      <p className="text-[11px] text-secondary/60 mt-1">Check back later or go live from the Creator Console!</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {streamsList.map((stream) => (
                        <div key={stream.creatorAddress} className="border border-gold-muted/30 rounded-xl p-5 bg-[#0d0b09] hover:border-gold-accent/40 transition-all flex flex-col justify-between gap-4">
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex gap-1.5 items-center">
                                <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full font-medium flex items-center gap-1">
                                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                                  {stream.platform && stream.platform !== "owncast" ? "VOD" : "Live"}
                                </span>
                                <span className="text-[9px] text-gold-accent bg-gold-accent/5 border border-gold-accent/20 px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider font-mono">
                                  {stream.platform || "owncast"}
                                </span>
                              </div>
                              <span className="text-[10px] text-secondary font-mono">{stream.creatorAddress.slice(0, 6)}...{stream.creatorAddress.slice(-4)}</span>
                            </div>
                            <h4 className="font-serif text-lg text-gold-bright">{stream.creatorName}</h4>
                            <p className="text-xs text-secondary mt-1">
                              {stream.platform === "jellyfin" ? (
                                <>Rate: <strong className="text-gold-accent">{(stream.ratePerSecond * 60 * 1.015).toFixed(4)} USDC</strong> / min</>
                              ) : stream.platform === "peertube" ? (
                                <>Price: <strong className="text-gold-accent">{(stream.ratePerSecond * 1.015).toFixed(3)} USDC</strong> (Flat)</>
                              ) : (
                                <>Rate: <strong className="text-gold-accent">{(stream.ratePerSecond * 1.015 * 2).toFixed(5)} USDC</strong> / 2s</>
                              )}{" "}
                              <span className="text-secondary text-[9px] font-normal">(incl. fee)</span>
                            </p>

                          </div>
                          <button
                            onClick={() => {
                              setSelectedCreator(stream);
                              setIsPlaying(false);
                            }}
                            className="w-full btn-gold text-xs py-2 justify-center"
                          >
                            Watch Stream
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Viewer Payment Activity History */}
              <div className="glass-panel p-6">
                <h3 className="text-xl mb-4 flex items-center gap-2">
                  <Activity className="w-4.5 h-4.5 text-gold-accent" />
                  Your Portal Billing History
                </h3>
                
                {recentViewerPayments.length === 0 ? (
                  <p className="text-xs text-secondary py-4 text-center border border-dashed border-gold-muted rounded-lg">
                    No streaming payments made in this browser session yet
                  </p>
                ) : (
                  <div className="max-h-56 overflow-y-auto pr-1">
                    <table className="w-full text-xs text-left">
                      <thead>
                        <tr className="border-b border-gold-muted text-secondary pb-2">
                          <th className="pb-2 font-medium">Payment ID</th>
                          <th className="pb-2 font-medium">Amount</th>
                          <th className="pb-2 font-medium">Timestamp</th>
                          <th className="pb-2 font-medium text-right">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gold-muted/5">
                        {recentViewerPayments.map(p => (
                          <tr key={p.id} className="hover:bg-card-hover/20">
                            <td className="py-2.5 font-mono text-[10px] text-secondary">
                              {p.txHash ? (
                                <a 
                                  href={`https://testnet.arcscan.app/tx/${p.txHash}`}
                                  target="_blank" 
                                  rel="noopener noreferrer"
                                  className="text-gold-accent hover:text-gold-bright underline inline-flex items-center gap-0.5"
                                >
                                  {p.id} <ExternalLink className="w-2.5 h-2.5" />
                                </a>
                              ) : (
                                p.id
                              )}
                            </td>
                            <td className="py-2.5 font-medium text-gold-bright">{p.amount} USDC</td>
                            <td className="py-2.5 text-secondary">{p.time}</td>
                            <td className="py-2.5 text-right">
                              {p.success ? (
                                <span className="text-blue-400 bg-blue-400/5 px-2 py-0.5 rounded text-[10px]">Settled</span>
                              ) : (
                                <span className="text-red-400 bg-red-400/5 px-2 py-0.5 rounded text-[10px]">Failed</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* Right: Ephemeral Viewer Wallet Controller */}
            <div className="flex flex-col gap-6">
              <div className="glass-panel p-6">
                <div className="flex items-center justify-between mb-4 border-b border-gold-muted pb-3">
                  <h3 className="text-xl flex items-center gap-2">
                    <Wallet className="w-4.5 h-4.5 text-gold-accent" />
                    Viewer Wallet
                  </h3>
                  <button 
                    onClick={handleResetWallet}
                    className="text-[10px] text-secondary hover:text-gold-accent flex items-center gap-1"
                    title="Generate New Session Key"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Reset Key
                  </button>
                </div>

                {/* MetaMask connection prompt if not connected */}
                {!connectedAddress && (
                  <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4 text-center mb-4">
                    <p className="text-xs text-amber-300 mb-3">Connect MetaMask to deposit USDC into the Gateway.</p>
                    <button onClick={connectWallet} className="btn-gold text-xs px-4 py-2 mx-auto flex items-center gap-2">
                      <Wallet className="w-4 h-4" />
                      Connect MetaMask
                    </button>
                  </div>
                )}

                {/* Balances Card */}
                <div className="bg-[#0f0e0b] border border-gold-muted rounded-xl p-4 flex flex-col gap-4 mb-4">
                  {connectedAddress && (
                    <div>
                      <label className="text-[10px] uppercase font-semibold text-secondary block">MetaMask Wallet (Source)</label>
                      <div className="font-mono text-xs text-gold-bright truncate mt-1 bg-[#14120f] px-2.5 py-1.5 rounded border border-gold-muted/10">
                        {connectedAddress}
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="text-[10px] uppercase font-semibold text-secondary block">Session Address (Target)</label>
                    <div className="font-mono text-xs text-secondary truncate mt-1 bg-[#14120f] px-2.5 py-1.5 rounded border border-gold-muted/10">
                      {viewerAddress || "Generating..."}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <span className="text-[10px] uppercase font-semibold text-secondary block">Session On-chain</span>
                      <strong className="text-lg text-secondary">{viewerWalletBalance} <span className="text-xs text-secondary font-normal">USDC</span></strong>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase font-semibold text-secondary block">Session Gateway</span>
                      <strong className="text-lg text-gold-accent">{viewerGatewayBalance} <span className="text-xs text-secondary font-normal">USDC</span></strong>
                    </div>
                  </div>
                </div>

                {/* Funding help action */}
                <button
                  onClick={handleFaucetFund}
                  className="w-full btn-outline text-xs justify-center mb-6 py-2.5"
                >
                  Fund MetaMask/Session via Faucet
                </button>

                {/* Deposit action */}
                <div className="border-t border-gold-muted pt-4">
                  <h4 className="text-sm font-semibold tracking-wide uppercase text-secondary mb-3">Deposit into Gateway</h4>
                  <div className="flex gap-2">
                    <div className="relative flex-grow">
                      <input 
                        type="number"
                        step="0.1"
                        value={depositAmount}
                        onChange={(e) => setDepositAmount(e.target.value)}
                        className="input-field pr-12 text-sm"
                        placeholder="Amount"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-secondary font-medium">USDC</span>
                    </div>
                    <button
                      onClick={handleDeposit}
                      disabled={isDepositing || !depositAmount}
                      className="btn-gold px-4 py-2"
                    >
                      {isDepositing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                      Deposit
                    </button>
                  </div>
                  <p className="text-[10px] text-secondary mt-1.5 leading-relaxed">
                    MetaMask deposits USDC directly to the session wallet's Gateway balance. High-frequency micropayments are signed popup-free from the session key.
                  </p>
                </div>
              </div>

              {/* Quick instructions card */}
              <div className="glass-panel p-6 bg-[#0a0907]">
                <h4 className="text-sm uppercase font-semibold text-gold-accent mb-2">Instructions</h4>
                <ol className="text-xs text-secondary list-decimal list-inside space-y-2">
                  <li>Connect MetaMask and switch to Arc Testnet.</li>
                  <li>Fund your connected address using the Circle Faucet button above.</li>
                  <li>Deposit some USDC (e.g. 0.5 USDC) into the Circle Gateway.</li>
                  <li>Click "Pay & Watch" to stream the live Owncast video and verify live micropayments.</li>
                </ol>
              </div>
            </div>
          </div>
        ) : (
          /* ========================================================================= */
          /* CREATOR DASHBOARD TAB                                                    */
          /* ========================================================================= */
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            
            {/* Left/Middle: Live Statistics and Chart */}
            <div className="lg:col-span-2 flex flex-col gap-6">
              
              {/* Earnings overview cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="glass-panel p-5">
                  <span className="text-[10px] uppercase font-semibold text-secondary block">Active Viewers</span>
                  <div className="flex items-baseline gap-2 mt-2">
                    <span className="font-serif text-4xl text-primary">{creatorStats.activeViewers}</span>
                    <span className="text-xs text-[#60a5fa] bg-[#60a5fa]/10 px-1.5 py-0.5 rounded font-medium">Streaming</span>
                  </div>
                </div>

                <div className="glass-panel p-5">
                  <span className="text-[10px] uppercase font-semibold text-secondary block">Total Gross Revenue</span>
                  <div className="flex items-baseline gap-2 mt-2">
                    <span className="font-serif text-4xl text-gold-accent">{parseFloat(creatorStats.totalReceived).toFixed(4)}</span>
                    <span className="text-xs text-secondary font-medium">USDC</span>
                  </div>
                  <span className="text-[9px] text-secondary mt-1.5 block">
                    Net: <strong className="text-gold-bright">{(parseFloat(creatorStats.totalReceived) * 100 / 101.5).toFixed(4)} USDC</strong> | Fee: <strong className="text-gold-bright">{(parseFloat(creatorStats.totalReceived) * 1.5 / 101.5).toFixed(4)} USDC</strong>
                  </span>
                </div>

                <div className="glass-panel p-5">
                  <span className="text-[10px] uppercase font-semibold text-secondary block">Gateway Available Balance</span>
                  <div className="flex items-baseline gap-2 mt-2">
                    <span className="font-serif text-4xl text-primary">{parseFloat(creatorStats.gateway.available).toFixed(4)}</span>
                    <span className="text-xs text-secondary font-medium">USDC</span>
                  </div>
                  <span className="text-[9px] text-secondary mt-1.5 block">
                    Net Payout: <strong className="text-gold-bright">{(parseFloat(creatorStats.gateway.available) * 100 / 101.5).toFixed(4)} USDC</strong> | Fee: <strong className="text-gold-bright">{(parseFloat(creatorStats.gateway.available) * 1.5 / 101.5).toFixed(4)} USDC</strong>
                  </span>
                </div>
              </div>

              {/* Earnings chart */}
              <div className="glass-panel p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xl flex items-center gap-2">
                    <TrendingUp className="w-5 h-5 text-gold-accent" />
                    Accumulated Earnings (Live Feed)
                  </h3>
                  <span className="text-xs text-secondary">Updated real-time</span>
                </div>
                {renderEarningsChart()}
              </div>

              {/* Heartbeats Table */}
              <div className="glass-panel p-6">
                <h3 className="text-xl mb-4 flex items-center gap-2">
                  <Activity className="w-5 h-5 text-gold-accent" />
                  Live Micropayment Ledger
                </h3>
                
                {creatorStats.heartbeats.length === 0 ? (
                  <p className="text-xs text-secondary py-6 text-center border border-dashed border-gold-muted rounded-lg">
                    No payment heartbeats registered yet. Open the Viewer portal to start watching.
                  </p>
                ) : (
                  <div className="max-h-60 overflow-y-auto pr-1">
                    <table className="w-full text-xs text-left">
                      <thead>
                        <tr className="border-b border-gold-muted text-secondary pb-2">
                          <th className="pb-2 font-medium">Payer Address</th>
                          <th className="pb-2 font-medium">Amount</th>
                          <th className="pb-2 font-medium">Timestamp</th>
                          <th className="pb-2 font-medium text-right">Arcscan Link</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gold-muted/5">
                        {creatorStats.heartbeats.map(h => (
                          <tr key={h.id} className="hover:bg-card-hover/20">
                            <td className="py-2.5 font-mono text-[11px] text-gold-bright truncate max-w-[150px]">{h.payer}</td>
                            <td className="py-2.5 font-medium">{h.amount} USDC</td>
                            <td className="py-2.5 text-secondary">{new Date(h.timestamp).toLocaleTimeString()}</td>
                            <td className="py-2.5 text-right">
                              {h.txHash ? (
                                <a 
                                  href={`https://testnet.arcscan.app/tx/${h.txHash}`}
                                  target="_blank" 
                                  rel="noopener noreferrer"
                                  className="text-gold-accent hover:text-gold-bright inline-flex items-center gap-1"
                                >
                                  Tx
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              ) : (
                                <span className="text-secondary italic">pending</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* Right Side: Creator Configuration & Withdrawals */}
            <div className="flex flex-col gap-6">

              {/* Creator Wallet Registration card */}
              <div className="glass-panel p-6">
                <h3 className="text-xl mb-4 border-b border-gold-muted pb-3 flex items-center gap-2">
                  <UserCheck className="w-4.5 h-4.5 text-gold-accent" />
                  Register Creator Wallet
                </h3>
                
                <div className="flex flex-col gap-4">
                  {connectedAddress ? (
                    <div>
                      <label className="text-[10px] uppercase font-semibold text-secondary block mb-1.5">Connected MetaMask Wallet</label>
                      <div className="font-mono text-sm text-gold-bright truncate bg-[#0f0e0b] px-2.5 py-1.5 rounded border border-gold-muted/10">
                        {connectedAddress}
                      </div>
                      
                      <button
                        onClick={handleRegisterCreator}
                        disabled={isRegisteringCreator}
                        className="w-full btn-gold text-xs justify-center py-2.5 mt-4"
                      >
                        {isRegisteringCreator ? (
                          <>
                            <RefreshCw className="w-4.5 h-4.5 animate-spin" />
                            Registering...
                          </>
                        ) : (
                          <>
                            <UserCheck className="w-4.5 h-4.5" />
                            Register Connected Wallet as Creator
                          </>
                        )}
                      </button>
                    </div>
                  ) : (
                    <div className="text-center py-4">
                      <p className="text-xs text-secondary mb-3">Please connect your MetaMask wallet to register as a Creator.</p>
                      <button
                        onClick={connectWallet}
                        className="btn-gold text-xs px-4 py-2 mx-auto flex items-center gap-2"
                      >
                        <Wallet className="w-4 h-4" />
                        Connect MetaMask
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Creator Settings / Go Live card */}
              <div className="glass-panel p-6">
                <h3 className="text-xl mb-4 border-b border-gold-muted pb-3 flex items-center gap-2">
                  <Settings className="w-4.5 h-4.5 text-gold-accent" />
                  Broadcaster Console
                </h3>

                {/* Creator Address Display */}
                <div className="mb-4">
                  <label className="text-[10px] uppercase font-semibold text-secondary block">Creator Wallet Address</label>
                  <div className="font-mono text-[10px] text-secondary truncate mt-1 bg-[#0f0e0b] p-2 rounded border border-gold-muted/10 mb-2">
                    {creatorStats.sellerAddress}
                  </div>
                  
                  <div className="flex justify-between items-center text-xs mt-2 bg-[#0f0e0b]/50 p-2 rounded border border-gold-muted/10">
                    <span className="text-secondary font-medium">Gas Balance:</span>
                    <strong className={parseFloat(creatorStats.gasBalance) < 0.005 ? "text-[#f87171] font-mono" : "text-[#4ade80] font-mono"}>
                      {parseFloat(creatorStats.gasBalance).toFixed(4)} USDC
                    </strong>
                  </div>
                  
                  {parseFloat(creatorStats.gasBalance) < 0.005 && (
                    <div className="mt-2.5 p-2 rounded bg-amber-500/10 border border-amber-500/20 text-[10px] text-amber-300 leading-normal">
                      ⚠️ Low gas warning. Please fund your wallet.
                    </div>
                  )}

                  <button
                    onClick={() => {
                      setSuccessMsg(`Please fund address: ${creatorStats.sellerAddress} using the Circle Faucet!`);
                      window.open("https://faucet.circle.com/", "_blank");
                    }}
                    className="w-full btn-outline text-[10px] justify-center py-1.5 mt-2.5"
                    style={{ fontSize: '10px', padding: '6px 12px' }}
                  >
                    Fund Creator Gas via Faucet
                  </button>
                </div>

                {!isStreamActive ? (
                  <div className="flex flex-col gap-4 border-t border-gold-muted pt-4">
                    <h4 className="text-xs uppercase font-semibold text-secondary">Go Live Setup</h4>
                    
                    <div>
                      <label className="text-[10px] uppercase font-semibold text-secondary block mb-1">Select Platform Type</label>
                      <select 
                        value={platformType}
                        onChange={(e) => setPlatformType(e.target.value as any)}
                        className="input-field text-xs bg-[#0c0a08] border border-gold-muted/30 rounded text-gold-bright"
                      >
                        <option value="owncast">Owncast Live (HLS Proxy Gate)</option>
                        <option value="jellyfin">Jellyfin VOD (Webhook Sidecar)</option>
                        <option value="peertube">PeerTube VOD (Payments Plugin)</option>
                      </select>
                    </div>

                    <div>
                      <label className="text-[10px] uppercase font-semibold text-secondary block mb-1">Display Name / Channel Name</label>
                      <input 
                        type="text"
                        value={creatorNameInput}
                        onChange={(e) => setCreatorNameInput(e.target.value)}
                        className="input-field text-xs"
                        placeholder="e.g. Alice Stream"
                      />
                    </div>

                    {platformType === "owncast" && (
                      <>
                        <div>
                          <label className="text-[10px] uppercase font-semibold text-secondary block mb-1">Secret Owncast HLS Stream URL</label>
                          <input 
                            type="text"
                            value={owncastUrlInput}
                            onChange={(e) => setOwncastUrlInput(e.target.value)}
                            className="input-field text-xs"
                            placeholder="e.g. https://your-owncast-server.com/hls/stream.m3u8"
                          />
                          <span className="text-[9px] text-secondary mt-1 block">
                            Never exposed to viewers. Kept secure on backend.
                          </span>
                        </div>

                        <div>
                          <label className="text-[10px] uppercase font-semibold text-secondary block mb-1">Billing Rate (USDC/sec)</label>
                          <input 
                            type="number"
                            step="0.00001"
                            value={newRate}
                            onChange={(e) => setNewRate(e.target.value)}
                            className="input-field text-xs"
                            placeholder="e.g. 0.0001"
                          />
                          <span className="text-[9px] text-secondary mt-1 block">
                            Rate: <strong className="text-gold-bright">{(parseFloat(newRate || "0") * 2).toFixed(5)} USDC</strong> per 2s (Viewer pays <strong className="text-gold-bright">{(parseFloat(newRate || "0") * 1.015 * 2).toFixed(5)} USDC</strong>, incl. 1.5% fee)
                          </span>
                        </div>
                      </>
                    )}

                    {platformType === "jellyfin" && (
                      <>
                        <div>
                          <label className="text-[10px] uppercase font-semibold text-secondary block mb-1">Movie / Show Title</label>
                          <input 
                            type="text"
                            value={jellyfinItemName}
                            onChange={(e) => setJellyfinItemName(e.target.value)}
                            className="input-field text-xs"
                            placeholder="e.g. Big Buck Bunny (VOD)"
                          />
                        </div>

                        <div>
                          <label className="text-[10px] uppercase font-semibold text-secondary block mb-1">Jellyfin Server URL (Optional)</label>
                          <input 
                            type="text"
                            value={owncastUrlInput}
                            onChange={(e) => setOwncastUrlInput(e.target.value)}
                            className="input-field text-xs"
                            placeholder="e.g. http://localhost:8096"
                          />
                        </div>

                        <div>
                          <label className="text-[10px] uppercase font-semibold text-secondary block mb-1">Billing Rate (USDC/minute)</label>
                          <input 
                            type="number"
                            step="0.001"
                            value={jellyfinRatePerMinute}
                            onChange={(e) => setJellyfinRatePerMinute(e.target.value)}
                            className="input-field text-xs"
                            placeholder="e.g. 0.006"
                          />
                          <span className="text-[9px] text-secondary mt-1 block">
                            Calculated per-minute: Viewer pays <strong className="text-gold-bright">{(parseFloat(jellyfinRatePerMinute || "0") * 1.015).toFixed(4)} USDC</strong> / min (incl. 1.5% fee)
                          </span>
                          <span className="text-[9px] text-amber-400 mt-1.5 block">
                            💡 Setup: Configure Jellyfin Webhook URL to: <code className="font-mono text-gold-accent select-all">http://localhost:3001/api/webhooks/jellyfin</code>
                          </span>
                        </div>
                      </>
                    )}

                    {platformType === "peertube" && (
                      <>
                        <div>
                          <label className="text-[10px] uppercase font-semibold text-secondary block mb-1">Video Title</label>
                          <input 
                            type="text"
                            value={peertubeVideoTitle}
                            onChange={(e) => setPeertubeVideoTitle(e.target.value)}
                            className="input-field text-xs"
                            placeholder="e.g. Sintel (Federated)"
                          />
                        </div>

                        <div>
                          <label className="text-[10px] uppercase font-semibold text-secondary block mb-1">PeerTube Video URL / ID</label>
                          <input 
                            type="text"
                            value={owncastUrlInput}
                            onChange={(e) => setOwncastUrlInput(e.target.value)}
                            className="input-field text-xs"
                            placeholder="e.g. https://peertube.xyz/videos/watch/123"
                          />
                        </div>

                        <div>
                          <label className="text-[10px] uppercase font-semibold text-secondary block mb-1">Flat Payment Price (USDC)</label>
                          <input 
                            type="number"
                            step="0.01"
                            value={peertubeAmount}
                            onChange={(e) => setPeertubeAmount(e.target.value)}
                            className="input-field text-xs"
                            placeholder="e.g. 0.05"
                          />
                          <span className="text-[9px] text-secondary mt-1 block">
                            Flat Video Purchase Rate: Viewer pays <strong className="text-gold-bright">{(parseFloat(peertubeAmount || "0") * 1.015).toFixed(4)} USDC</strong> (incl. 1.5% fee)
                          </span>
                          <span className="text-[9px] text-amber-400 mt-1.5 block">
                            💡 Setup: Exposes PR #6300 webhook compatibility. Manifest routes automatically configured.
                          </span>
                        </div>
                      </>
                    )}


                    <button
                      onClick={handleGoLive}
                      disabled={isRegisteringCreator || !connectedAddress}
                      className="w-full btn-gold text-xs justify-center py-2.5 mt-2"
                    >
                      {isRegisteringCreator ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          Going Live...
                        </>
                      ) : (
                        <>
                          <Play className="w-4.5 h-4.5 fill-current" />
                          Go Live
                        </>
                      )}
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-4 border-t border-gold-muted pt-4 bg-[#0a0907]/50 p-4 rounded-xl border border-gold-muted/10">
                    <div className="flex items-center gap-2">
                      <span className="pulse-dot bg-[#4ade80]"></span>
                      <span className="text-xs font-semibold text-[#4ade80] uppercase">Stream Active</span>
                    </div>
                    
                    <div className="text-xs text-secondary">
                      <div>Name: <strong className="text-gold-bright">{creatorNameInput}</strong></div>
                      <div className="mt-1">Rate: <strong className="text-gold-bright">{(parseFloat(newRate || "0") * 2).toFixed(5)} USDC</strong> / 2s (Viewer pays <strong className="text-gold-bright">{(parseFloat(newRate || "0") * 1.015 * 2).toFixed(5)} USDC</strong>)</div>
                    </div>

                    <div className="border-t border-gold-muted/30 pt-3">
                      <span className="text-[10px] uppercase font-semibold text-secondary block mb-1">Shareable Stream Link:</span>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[9px] text-gold-muted truncate flex-grow bg-[#0f0e0b] p-1.5 rounded border border-gold-muted/10">
                          {`${window.location.origin}/?creator=${connectedAddress}`}
                        </span>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(`${window.location.origin}/?creator=${connectedAddress}`);
                            setSuccessMsg("Copied shareable link to clipboard!");
                          }}
                          className="text-[9px] border border-gold-muted px-2 py-1.5 rounded hover:border-gold-accent text-gold-accent hover:text-gold-bright transition-all bg-[#0f0e0b]"
                        >
                          Copy
                        </button>
                      </div>
                    </div>

                    <button
                      onClick={handleStopLive}
                      disabled={isRegisteringCreator}
                      className="w-full bg-red-400 text-black hover:bg-red-300 font-semibold text-xs justify-center py-2.5 rounded-lg flex items-center gap-1.5 transition-all mt-2"
                    >
                      {isRegisteringCreator ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          Stopping...
                        </>
                      ) : (
                        <>
                          <Pause className="w-4 h-4 fill-current" />
                          Stop Stream
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>

              {/* Cross-chain Withdrawals card */}
              <div className="glass-panel p-6">
                <h3 className="text-xl mb-4 border-b border-gold-muted pb-3 flex items-center gap-2">
                  <ArrowUpRight className="w-4.5 h-4.5 text-gold-accent" />
                  Circle Gateway Withdraw
                </h3>

                <div className="flex flex-col gap-4">
                  <div>
                    <label className="text-[10px] uppercase font-semibold text-secondary block mb-1.5">Amount to Withdraw</label>
                    <div className="relative">
                      <input 
                        type="number"
                        step="0.1"
                        value={withdrawAmount}
                        onChange={(e) => setWithdrawAmount(e.target.value)}
                        className="input-field pr-12 text-sm"
                        placeholder="0.00"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-secondary font-medium">USDC</span>
                    </div>
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-semibold text-secondary block mb-1.5">Destination Chain</label>
                    <select
                      value={withdrawChain}
                      onChange={(e) => setWithdrawChain(e.target.value)}
                      className="input-field text-sm"
                    >
                      <option value="arcTestnet">Arc Testnet</option>
                      <option value="baseSepolia">Base Sepolia</option>
                      <option value="sepolia">Ethereum Sepolia</option>
                      <option value="arbitrumSepolia">Arbitrum Sepolia</option>
                      <option value="optimismSepolia">Optimism Sepolia</option>
                      <option value="avalancheFuji">Avalanche Fuji</option>
                      <option value="polygonAmoy">Polygon Amoy</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-semibold text-secondary block mb-1.5">Recipient Wallet Address (Optional)</label>
                    <input 
                      type="text"
                      value={withdrawAddress}
                      onChange={(e) => setWithdrawAddress(e.target.value)}
                      className="input-field text-xs"
                      placeholder="Defaults to Creator Address"
                    />
                  </div>

                  <button
                    onClick={handleWithdraw}
                    disabled={isWithdrawing || !withdrawAmount}
                    className="w-full btn-gold text-xs justify-center py-2.5 mt-2"
                  >
                    {isWithdrawing ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Withdrawing...
                      </>
                    ) : (
                      <>
                        <ArrowUpRight className="w-4 h-4" />
                        Execute Withdrawal
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Withdrawal history */}
              <div className="glass-panel p-6">
                <h4 className="text-sm uppercase font-semibold text-gold-accent mb-3">Withdrawal Logs</h4>
                {creatorStats.withdrawals.length === 0 ? (
                  <p className="text-xs text-secondary text-center py-4 border border-dashed border-gold-muted rounded-lg">
                    No withdrawals triggered yet
                  </p>
                ) : (
                  <div className="space-y-3 max-h-48 overflow-y-auto pr-1">
                    {creatorStats.withdrawals.map(w => (
                      <div key={w.id} className="text-xs border-b border-gold-muted/10 pb-2 flex justify-between items-center">
                        <div>
                          <strong className="text-gold-bright">{w.amount} USDC</strong>
                          <span className="text-[10px] text-secondary block">Chain: {w.destinationChain}</span>
                          {w.txHash && (
                            <a 
                              href={getExplorerTxLink(w.destinationChain, w.txHash)} 
                              target="_blank" 
                              rel="noopener noreferrer" 
                              className="text-[10px] text-gold-accent hover:text-gold-bright underline inline-flex items-center gap-0.5 mt-0.5"
                            >
                              View Tx <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          )}
                        </div>
                        <div className="text-right">
                          {w.status === "confirmed" ? (
                            <span className="text-blue-400 text-[10px] font-medium bg-blue-400/5 px-2 py-0.5 rounded">Confirmed</span>
                          ) : w.status === "failed" ? (
                            <span className="text-red-400 text-[10px] font-medium bg-red-400/5 px-2 py-0.5 rounded">Failed</span>
                          ) : (
                            <span className="text-secondary text-[10px] font-medium bg-secondary/5 px-2 py-0.5 rounded">Pending</span>
                          )}
                          <span className="text-[9px] text-secondary block mt-0.5">{new Date(w.timestamp).toLocaleTimeString()}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

            </div>
          </div>
        )}
      </main>
    </div>
  );
}
