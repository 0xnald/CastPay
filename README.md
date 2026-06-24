# CastPay: Continuous Streaming Monetization Infrastructure

[![Chain](https://img.shields.io/badge/Network-Arc--Testnet-amber)](https://testnet.arcscan.app)
[![Token](https://img.shields.io/badge/Asset-USDC-blue)](https://faucet.circle.com)
[![Protocol](https://img.shields.io/badge/Powered--by-Circle--Gateway-darkgreen)](https://github.com/circlefin)

CastPay is a non-custodial pay-per-second and pay-per-minute settlement sidecar for live video streams (HLS) and Video on Demand (VOD) catalogs. Built for the **Arc Testnet** and powered by **Circle Gateway** pre-authorized USDC batching, it enables frictionless, popup-free micro-payments for viewers while allowing content creators to instantly withdraw earnings to any target EVM chain.

---

## 🚀 Key Engineering & Architecture Features

1. **Non-Custodial Micropayments (Zero MetaMask Popups)**:
   High-frequency pay-per-second streaming cannot prompt MetaMask signatures repeatedly. CastPay generates a local, ephemeral **Session Key** in the browser. The viewer makes a single MetaMask transaction to fund this session balance via `depositFor(usdc, sessionAddress, amount)` on the Gateway contract. The browser then signs high-frequency heartbeats popup-free.

2. **Premium Glassmorphic Design System**:
   The entire portal utilizes custom CSS variables, heavy backdrop filters (`blur(16px)`), semi-transparent dark backgrounds (`rgba(20, 18, 15, 0.55)`), muted gold borders (`rgba(197, 168, 128, 0.12)`), and custom ambient glow decorations. Interaction states feature tactile scaling transitions (shrinking to `scale(0.96)` on click) and sticky header scroll-fades.

3. **Multi-Platform Integration**:
   - **Owncast (Live HLS Proxy)**: Live stream pay-per-second. The sidecar rewrites `.m3u8` playlists on-the-fly, serving video segments only to viewers with active heartbeats.
   - **Jellyfin (VOD Webhook Sidecar)**: Gated per-minute VOD. Listens to Jellyfin's webhook callbacks (`PlaybackStart`, `PlaybackProgress`, `PlaybackStop`) to settle pro-rated watching time down to the exact second.
   - **PeerTube (Payments Plugin)**: Federated VOD. Settle flat-fee tip unlocks using the payments plugin schema.

4. **Platform Fee Splits on Withdrawals**:
   EIP-3009 does not support multiple payees in a single pre-authorized signature. To avoid forcing viewers to sign two separate transactions per heartbeat (which doubles RPC calls and chokes browser event loops), the viewer pays the full amount to the creator's gateway balance. Upon withdrawal, the creator signs two separate `BurnIntent` payloads sequentially (Net amount to creator, and 1.5% Platform Fee to the platform wallet).

5. **Cross-Chain Minting (Arc L1 to Destination Chain)**:
   Creators sign their withdrawal intents in MetaMask. The backend proxies these burn intents to Circle Gateway on Arc L1, retrieving the attestation payload. The frontend then switches MetaMask to the destination chain (e.g. Base Sepolia) and triggers `gatewayMint` directly to receive the USDC funds.

6. **Scale & Performance Optimizations**:
   - **Asynchronous settlements**: Signature verification is synchronous (~10ms), while on-chain gateway settlements run asynchronously in the background so segment delivery never blocks.
   - **HLS Segment Memory Cache**: Caches segments for 30s in backend memory to insulate the creator's home server from multiple concurrent viewers.
   - **Clock Jitter Tolerance**: Client-side signature validity is automatically padded with a 1-day safety margin to prevent signature expiration errors due to clock skew or network latency.

---

## 📂 Repository Structure

```
├── packages
│   ├── backend
│   │   ├── src/server.ts      # Express settlement server, segment proxy, & webhooks receiver
│   │   └── package.json
│   └── frontend
│       ├── src/App.tsx        # React client app with MetaMask EIP-712 signing & SPA Router
│       ├── src/index.css      # Custom glassmorphic styling system & shrink animations
│       ├── vercel.json        # SPA route fallback rewrites
│       └── package.json
├── DOCS.md                    # GitBook user onboarding document source
├── README.md                  # Infrastructure overview & developer documentation
└── package.json               # Monorepo workspaces definition
```

---

## 🛠️ Local Development & Setup

### Prerequisites
- Node.js (v18+)
- MetaMask wallet with some testnet gas and USDC.

### 1. Installation
Install all monorepo dependencies from the root directory:
```bash
npm install
```

### 2. Configure Environment Variables
Create a `.env.local` file in the root workspace folder:
```ini
# Custom Canteen JSON-RPC Endpoint (provided during CLI setup)
RPC="https://rpc.testnet.arc-node.thecanteenapp.com/v1/swrm_4ba1cb60eb915a5285d7d4fb29e0923321af16cb4f0e2257aa3920a3a33dab2f"

# Backend server variables
BACKEND_URL="http://localhost:3001"
```

### 3. Run Backend Settlement Server
```bash
# Start backend server on port 3001
npm run dev:backend
```

### 4. Run Frontend Portal
```bash
# Start Vite React frontend on port 3000
npm run dev:frontend
```
Open `http://localhost:3000` to interact with the CastPay portal.

---

## 🧪 Simulation & Verification Flow

To verify all multi-platform integrations in a single browser tab, we have built-in simulated environments directly in the app:
1. **Owncast Simulation**: Go live in the Creator Console, copy the gated URL, fund the gateway, and click **Pay & Watch** to verify HLS segment gating.
2. **Jellyfin VOD Simulation**: Register a simulated movie and open the Jellyfin simulator tab. Click **Play** and **Simulate 1 Min Watch** to see the backend sidecar parse progress webhooks and trigger pro-rated on-chain settlements.
3. **PeerTube Tip Simulation**: Register a PeerTube VOD tip, switch to the PeerTube simulator tab, and verify flat-fee tips unlock VOD access instantly.

---

## 🌐 Deployment

### Vercel (Frontend)
Vercel automatically detects the Vite app and uses `packages/frontend/vercel.json` to handle SPA path fallback routing seamlessly (redirecting requests for `/docs`, `/dashboard`, or `/viewerportal` to `index.html`).

### Railway (Backend)
Deploy the backend package to Railway, ensuring the `RPC` env variable is set to your canteen RPC node.
