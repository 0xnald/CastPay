# CastPay: Owncast & OBS Local Gating Guide

This guide walks you through setting up a local video stream using **Owncast** (in Docker) and **OBS Studio**, exposing it securely to the internet, and gating access to the stream on **`castpay.app`** using pay-per-second USDC billing.

---

## Prerequisites

Before starting, ensure you have the following installed on your computer:
1. **Docker Desktop**: [Download and install](https://www.docker.com/products/docker-desktop/)
2. **OBS Studio**: [Download and install](https://obsproject.com/)
3. **MetaMask**: A browser extension loaded with some testnet gas and USDC.

---

## Step 1: Run Owncast via Docker

Open your terminal (PowerShell on Windows, or Bash on macOS/Linux) and run the following command to start Owncast:

```bash
docker run --name owncast -d -p 8080:8080 -p 1935:1935 -v owncast_data:/app/data owncast/owncast:latest
```

### Port Breakdown:
* `-p 8080:8080`: Serves the Owncast web interface and video player (accessible at `http://localhost:8080`).
* `-p 1935:1935`: The RTMP ingest port used to receive live video feeds from OBS.
* `-v owncast_data:/app/data`: Mounts a persistent volume so your stream settings, admin password, and logs are saved.

---

## Step 2: Configure OBS & Start Streaming

1. Open **`http://localhost:8080/admin`** in your browser.
2. Log in using the default credentials:
   * **Username**: `admin`
   * **Password**: Check your docker container logs for the temporary password, or try `abc123`.
3. Go to **Configuration -> Stream Settings** in the left menu and copy your unique **Stream Key**.
4. Open **OBS Studio** and navigate to **Settings -> Stream**:
   * **Service**: Select `Custom...`
   * **Server**: `rtmp://localhost/live` (or `rtmp://127.0.0.1/live` / `rtmp://localhost:1935/live`)
   * **Stream Key**: Paste the stream key you copied from the admin panel.
5. Click **Start Streaming** in OBS. In a few seconds, the stream player at `http://localhost:8080` will show your live feed.

---

## Step 3: Expose Owncast to the Internet

Because **`castpay.app`** runs on a remote cloud server, it cannot reach `http://localhost:8080` directly. You need a public URL to tunnel traffic to your local computer.

Choose **one** of the two free options below to tunnel port `8080`:

### Option A: `localhost.run` (Recommended - Zero Installation)
This option uses the native SSH client already built into your operating system. No package installation or account signup is required.

Open your terminal and run:
```powershell
ssh -R 80:localhost:8080 nokey@localhost.run
```
> [!NOTE]
> If asked *`Are you sure you want to continue connecting (yes/no)?`*, type **`yes`** and press Enter.

Copy the output URL (e.g. `https://your-unique-subdomain.localhost.run`).

---

### Option B: `localtunnel` (Alternative - Node/NPM)
This option uses a Node package to establish the tunnel.

Open your terminal and run:
```bash
npx localtunnel --port 8080
```
> [!WARNING]
> If the localtunnel server is down or returns a connection-refused error, fall back to **Option A**.

Copy the output URL (e.g. `https://rude-colts-walk.loca.lt`).

---

## Step 4: Register & Gate your Stream on CastPay

Once you have your public tunnel URL, you are ready to configure CastPay:

1. Open **`https://castpay.app`** in your browser.
2. Click **Creator Console** and connect your MetaMask wallet (switch to the **Arc Testnet** when prompted).
3. Click **Register Connected Wallet as Creator** to link your payout profile.
4. Under **Configure Platform Distribution**, set the following options:
   * **Platform Type**: `Owncast Live (HLS Proxy Gate)`
   * **Secret Owncast HLS Stream URL**: Paste your public tunnel URL with `/hls/stream.m3u8` appended to the end.
     * *Example (Option A)*: `https://your-unique-subdomain.localhost.run/hls/stream.m3u8`
     * *Example (Option B)*: `https://rude-colts-walk.loca.lt/hls/stream.m3u8`
   * **Per-Second Billing Rate**: Set your stream price (e.g., `0.0001` USDC/sec).
5. Click **Go Live**.
   * CastPay will now wrap your public stream index and output a secure, gated playback link.

---

## Step 5: Verify Gated Access (Viewer View)

1. Open **`https://castpay.app`** on another computer (or a different browser tab) and go to the **Viewer Portal**.
2. Connect your wallet and deposit a small amount of USDC into the gateway balance (e.g. `1.00` USDC).
3. Find your registered stream under the active creators list.
4. Click **Pay & Watch**.
   * The browser will automatically generate a session key and submit EIP-712 billing heartbeats every 2 seconds.
   * Your video will play smoothly, and floating `+$0.0002 USDC` particles will rise on the player interface.
5. In your OBS logs or terminal, you will see the segment requests proxying in real-time!
