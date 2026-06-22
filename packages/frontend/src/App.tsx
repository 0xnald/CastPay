import { useState, useEffect, useRef } from "react";
import { 
  Play, 
  Pause, 
  Wallet, 
  Settings, 
  Coins, 
  ArrowUpRight, 
  Tv, 
  RefreshCw, 
  Plus, 
  TrendingUp, 
  ExternalLink,
  Activity
} from "lucide-react";
import Hls from "hls.js";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createPublicClient, http, formatUnits } from "viem";
import { arcTestnet } from "viem/chains";

const BACKEND_URL = "http://localhost:3001";
const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";
const ARC_TESTNET_RPC = "https://rpc.testnet.arc.network";

export default function App() {
  const [activeTab, setActiveTab] = useState<"viewer" | "creator">("viewer");
  
  // App States
  const [streamUrl, setStreamUrl] = useState("https://demo.owncast.online/hls/stream.m3u8");
  const [isPlaying, setIsPlaying] = useState(false);
  const [streamRate, setStreamRate] = useState(0.0001); // USDC per second
  const [backendStatus, setBackendStatus] = useState<"online" | "offline">("offline");

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
  const [isConfiguringRate, setIsConfiguringRate] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("0.10");
  const [withdrawChain, setWithdrawChain] = useState("arcTestnet");
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [withdrawAddress, setWithdrawAddress] = useState("");

  // Refs & Particle States
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const heartbeatIntervalRef = useRef<any>(null);
  const [particles, setParticles] = useState<Array<{ id: number; text: string; x: number; y: number }>>([]);
  const [recentViewerPayments, setRecentViewerPayments] = useState<Array<{ id: string; amount: string; time: string; success: boolean }>>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

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

  // Fetch stats periodically
  useEffect(() => {
    fetchBackendStats();
    const interval = setInterval(fetchBackendStats, 3000);
    return () => clearInterval(interval);
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
      if (isPlaying) {
        if (Hls.isSupported()) {
          const hls = new Hls();
          hls.loadSource(streamUrl);
          hls.attachMedia(videoRef.current);
          hlsRef.current = hls;
          videoRef.current.play().catch(err => console.log("Video auto play prevented", err));
        } else if (videoRef.current.canPlayType("application/vnd.apple.mpegurl")) {
          videoRef.current.src = streamUrl;
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
  }, [isPlaying, streamUrl]);

  // Heartbeat loop when streaming
  useEffect(() => {
    if (isPlaying) {
      // Start heartbeat every 2 seconds
      heartbeatIntervalRef.current = setInterval(sendHeartbeat, 2000);
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
  }, [isPlaying, viewerKey, streamRate]);

  const fetchBackendStats = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/stats`);
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
      const publicClient = createPublicClient({
        chain: arcTestnet,
        transport: http(ARC_TESTNET_RPC),
      });

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
      const gateway = new GatewayClient({
        chain: "arcTestnet",
        privateKey: viewerKey as `0x${string}`,
      });
      const balances = await gateway.getBalances();
      setViewerGatewayBalance(parseFloat(balances.gateway.formattedAvailable).toFixed(4));
    } catch (err) {
      console.warn("Failed to fetch viewer balances:", err);
    }
  };

  const sendHeartbeat = async () => {
    if (!viewerKey) return;
    try {
      const gateway = new GatewayClient({
        chain: "arcTestnet",
        privateKey: viewerKey as `0x${string}`,
      });

      const start = Date.now();
      const heartbeatPrice = (streamRate * 2).toFixed(6);

      // Call gateway.pay which handles 402 challange response automatically
      const result = await gateway.pay(`${BACKEND_URL}/api/heartbeat`, { method: "POST" });
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
          success: true
        },
        ...prev.slice(0, 9)
      ]);
    } catch (err) {
      console.error("Heartbeat billing failed:", err);
      setErrorMsg(`Payment failed: ${(err as Error).message}`);
      setIsPlaying(false); // Stop playback on billing failure

      setRecentViewerPayments(prev => [
        {
          id: `tx_${Date.now()}`,
          amount: (streamRate * 2).toFixed(6),
          time: new Date().toLocaleTimeString(),
          success: false
        },
        ...prev.slice(0, 9)
      ]);
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
    if (!viewerKey || isDepositing) return;
    setErrorMsg("");
    setSuccessMsg("");
    setIsDepositing(true);
    try {
      const gateway = new GatewayClient({
        chain: "arcTestnet",
        privateKey: viewerKey as `0x${string}`,
      });
      console.log(`Depositing ${depositAmount} USDC to Gateway...`);
      const result = await gateway.deposit(depositAmount);
      setSuccessMsg(`Deposit successful! Tx: ${result.depositTxHash.slice(0, 12)}...`);
      fetchViewerBalances();
    } catch (err) {
      setErrorMsg(`Deposit failed: ${(err as Error).message}`);
    } finally {
      setIsDepositing(false);
    }
  };

  const handleConfigureRate = async () => {
    if (isConfiguringRate) return;
    setErrorMsg("");
    setSuccessMsg("");
    setIsConfiguringRate(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/configure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rate: parseFloat(newRate) }),
      });
      if (res.ok) {
        setSuccessMsg("Streaming billing rate updated successfully!");
        fetchBackendStats();
      } else {
        const data = await res.json();
        setErrorMsg(`Failed: ${data.error}`);
      }
    } catch (err) {
      setErrorMsg("Failed to configure rate");
    } finally {
      setIsConfiguringRate(false);
    }
  };

  const handleWithdraw = async () => {
    if (isWithdrawing) return;
    setErrorMsg("");
    setSuccessMsg("");
    setIsWithdrawing(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: withdrawAmount,
          destinationChain: withdrawChain,
          destinationAddress: withdrawAddress || undefined,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setSuccessMsg(`Withdrawal complete! Mint Tx Hash: ${data.txHash.slice(0, 15)}...`);
        fetchBackendStats();
      } else {
        const data = await res.json();
        setErrorMsg(`Withdrawal failed: ${data.error || data.details}`);
      }
    } catch (err) {
      setErrorMsg("Withdrawal request failed");
    } finally {
      setIsWithdrawing(false);
    }
  };

  const handleFaucetFund = async () => {
    if (isFunding) return;
    setErrorMsg("");
    setSuccessMsg("");
    setIsFunding(true);
    
    // Direct link instruction
    setSuccessMsg(`Please fund address: ${viewerAddress} using the Circle Faucet!`);
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

  return (
    <div className="min-h-screen pb-12">
      {/* Upper Navigation Bar */}
      <header className="border-b border-gold-muted bg-[#0c0a08]/90 sticky top-0 z-50 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Coins className="w-7 h-7 text-gold-accent" />
            <div>
              <span className="font-serif text-2xl tracking-wide font-medium">CastPay</span>
              <span className="text-[10px] text-secondary border border-gold-muted px-1.5 py-0.5 rounded ml-2 uppercase font-medium">Arc L1</span>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            {backendStatus === "online" ? (
              <span className="text-xs text-[#60a5fa] bg-[#60a5fa]/10 px-2.5 py-1 rounded-full flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#60a5fa] animate-pulse"></span>
                Backend Active
              </span>
            ) : (
              <span className="text-xs text-red-400 bg-red-400/10 px-2.5 py-1 rounded-full flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400"></span>
                Backend Offline
              </span>
            )}
            
            <div className="flex p-0.5 bg-[#14120f] border border-gold-muted rounded-lg">
              <button 
                onClick={() => setActiveTab("viewer")}
                className={`px-4 py-1.5 rounded-md text-xs font-medium transition-all ${activeTab === "viewer" ? "bg-gold-accent text-bg-color" : "text-secondary hover:text-white"}`}
              >
                Viewer Portal
              </button>
              <button 
                onClick={() => setActiveTab("creator")}
                className={`px-4 py-1.5 rounded-md text-xs font-medium transition-all ${activeTab === "creator" ? "bg-gold-accent text-bg-color" : "text-secondary hover:text-white"}`}
              >
                Creator Console
              </button>
            </div>
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
        {activeTab === "viewer" ? (
          /* ========================================================================= */
          /* VIEWERS PORTAL TAB                                                       */
          /* ========================================================================= */
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left/Middle: Stream Player Card */}
            <div className="lg:col-span-2 flex flex-col gap-6">
              <div className="glass-panel overflow-hidden relative">
                {/* Streaming Header bar */}
                <div className="px-5 py-3.5 border-b border-gold-muted flex items-center justify-between bg-card-bg">
                  <div className="flex items-center gap-2">
                    <span className="pulse-dot"></span>
                    <span className="text-sm font-semibold tracking-wide uppercase">Owncast Live Stream</span>
                  </div>
                  <div className="text-xs text-secondary flex items-center gap-2">
                    <Activity className="w-3.5 h-3.5 text-gold-accent" />
                    <span>Rate: <strong className="text-gold-bright">{(streamRate * 2).toFixed(4)} USDC</strong> / 2s</span>
                  </div>
                </div>

                {/* Video container */}
                <div className="relative aspect-video bg-black flex items-center justify-center">
                  {isPlaying ? (
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
                        <h3 className="font-serif text-2xl text-gold-accent">Pay-Per-Second Portal</h3>
                        <p className="text-xs text-secondary max-w-sm mt-1">
                          Authorize streaming micropayments with your Gateway balance to watch this premium live stream.
                        </p>
                      </div>
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
                  <div className="w-full sm:w-2/3">
                    <label className="text-[10px] uppercase font-semibold text-secondary block mb-1">HLS Video Stream URL</label>
                    <input 
                      type="text"
                      value={streamUrl}
                      onChange={(e) => setStreamUrl(e.target.value)}
                      disabled={isPlaying}
                      className="input-field text-xs"
                      placeholder="e.g. https://demo.owncast.online/hls/stream.m3u8"
                    />
                  </div>

                  <button
                    onClick={() => setIsPlaying(!isPlaying)}
                    disabled={!viewerGatewayBalance || parseFloat(viewerGatewayBalance) <= 0}
                    className={`w-full sm:w-auto btn-gold px-6 ${isPlaying ? "bg-red-400 text-black hover:bg-red-300" : ""}`}
                  >
                    {isPlaying ? (
                      <>
                        <Pause className="w-4 h-4 fill-current" />
                        Disconnect
                      </>
                    ) : (
                      <>
                        <Play className="w-4 h-4 fill-current" />
                        Pay & Watch
                      </>
                    )}
                  </button>
                </div>
              </div>

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
                            <td className="py-2.5 font-mono text-[10px] text-secondary">{p.id}</td>
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
                    title="Generate New Private Key"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Reset
                  </button>
                </div>

                {/* Balances Card */}
                <div className="bg-[#0f0e0b] border border-gold-muted rounded-xl p-4 flex flex-col gap-4 mb-4">
                  <div>
                    <label className="text-[10px] uppercase font-semibold text-secondary block">EVM Wallet Address</label>
                    <div className="font-mono text-xs text-gold-bright truncate mt-1 bg-[#14120f] px-2.5 py-1.5 rounded border border-gold-muted/10">
                      {viewerAddress || "Generating..."}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <span className="text-[10px] uppercase font-semibold text-secondary block">On-chain Balance</span>
                      <strong className="text-lg text-primary">{viewerWalletBalance} <span className="text-xs text-secondary font-normal">USDC</span></strong>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase font-semibold text-secondary block">Circle Gateway</span>
                      <strong className="text-lg text-gold-accent">{viewerGatewayBalance} <span className="text-xs text-secondary font-normal">USDC</span></strong>
                    </div>
                  </div>
                </div>

                {/* Funding help action */}
                <button
                  onClick={handleFaucetFund}
                  className="w-full btn-outline text-xs justify-center mb-6 py-2.5"
                >
                  Fund Wallet via Circle Faucet
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
                    Gateway deposits batch off-chain signed messages, reducing gas costs significantly for pay-per-second flows.
                  </p>
                </div>
              </div>

              {/* Quick instructions card */}
              <div className="glass-panel p-6 bg-[#0a0907]">
                <h4 className="text-sm uppercase font-semibold text-gold-accent mb-2">Instructions</h4>
                <ol className="text-xs text-secondary list-decimal list-inside space-y-2">
                  <li>Fund the viewer wallet address above using the Circle Faucet on Arc Testnet.</li>
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
                  <span className="text-[10px] uppercase font-semibold text-secondary block">Total Revenue (Portal)</span>
                  <div className="flex items-baseline gap-2 mt-2">
                    <span className="font-serif text-4xl text-gold-accent">{parseFloat(creatorStats.totalReceived).toFixed(4)}</span>
                    <span className="text-xs text-secondary font-medium">USDC</span>
                  </div>
                </div>

                <div className="glass-panel p-5">
                  <span className="text-[10px] uppercase font-semibold text-secondary block">Gateway Available Balance</span>
                  <div className="flex items-baseline gap-2 mt-2">
                    <span className="font-serif text-4xl text-primary">{parseFloat(creatorStats.gateway.available).toFixed(4)}</span>
                    <span className="text-xs text-secondary font-medium">USDC</span>
                  </div>
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
              
              {/* Creator Settings card */}
              <div className="glass-panel p-6">
                <h3 className="text-xl mb-4 border-b border-gold-muted pb-3 flex items-center gap-2">
                  <Settings className="w-4.5 h-4.5 text-gold-accent" />
                  Stream Configuration
                </h3>

                {/* Creator Address Display */}
                <div className="mb-4">
                  <label className="text-[10px] uppercase font-semibold text-secondary block">Creator Wallet (Receives Funds)</label>
                  <div className="font-mono text-[10px] text-secondary truncate mt-1 bg-[#0f0e0b] p-2 rounded border border-gold-muted/10 mb-2">
                    {creatorStats.sellerAddress}
                  </div>
                  
                  <div className="flex justify-between items-center text-xs mt-2 bg-[#0f0e0b]/50 p-2 rounded border border-gold-muted/10">
                    <span className="text-secondary font-medium">Creator Gas Balance:</span>
                    <strong className={parseFloat(creatorStats.gasBalance) < 0.005 ? "text-[#f87171] font-mono" : "text-[#4ade80] font-mono"}>
                      {parseFloat(creatorStats.gasBalance).toFixed(4)} USDC
                    </strong>
                  </div>
                  
                  {parseFloat(creatorStats.gasBalance) < 0.005 && (
                    <div className="mt-2.5 p-2 rounded bg-amber-500/10 border border-amber-500/20 text-[10px] text-amber-300 leading-normal">
                      ⚠️ Creator has insufficient gas for withdrawals. Please use the button below to fund the creator wallet.
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

                {/* Rate setup */}
                <div className="mb-4">
                  <label className="text-[10px] uppercase font-semibold text-secondary block mb-1.5">Stream Billing Rate (USDC/sec)</label>
                  <div className="flex gap-2">
                    <input 
                      type="number"
                      step="0.00001"
                      value={newRate}
                      onChange={(e) => setNewRate(e.target.value)}
                      className="input-field text-sm"
                      placeholder="e.g. 0.0001"
                    />
                    <button
                      onClick={handleConfigureRate}
                      disabled={isConfiguringRate || !newRate}
                      className="btn-gold px-4 text-xs font-semibold"
                    >
                      Update
                    </button>
                  </div>
                  <span className="text-[10px] text-secondary block mt-1.5">
                    Current: <strong className="text-gold-bright">{(streamRate * 2).toFixed(5)} USDC</strong> per 2-second heartbeat
                  </span>
                </div>
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
