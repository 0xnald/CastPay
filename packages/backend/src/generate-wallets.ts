import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as fs from "fs";
import * as path from "path";

// Write .env.local in the monorepo root
const envPath = path.resolve(__dirname, "../../../.env.local");

const replaceOrAppend = (content: string, key: string, line: string) => {
  const regex = new RegExp(`^${key}=.*$`, "m");
  return regex.test(content)
    ? content.replace(regex, line)
    : content.trimEnd() + "\n" + line;
};

const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;

const generateWallet = (label: string) => {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  console.log(`\n${bold(label)}`);
  console.log(`  Address:     ${cyan(account.address)}`);
  console.log(`  Private key: ${cyan(privateKey)}`);
  return { address: account.address, privateKey };
};

console.log("Generating wallets for CastPay...");

// 1. Seller wallet (the creator receiving funds)
const seller = generateWallet("Creator / Seller Wallet (receives USDC)");

// 2. Buyer wallet (the viewer paying USDC)
const buyer = generateWallet("Viewer / Buyer Wallet (sends USDC)");

const lines: Record<string, string> = {
  SELLER_ADDRESS: seller.address,
  SELLER_PRIVATE_KEY: seller.privateKey,
  BUYER_ADDRESS: buyer.address,
  BUYER_PRIVATE_KEY: buyer.privateKey,
};

let content = fs.existsSync(envPath)
  ? fs.readFileSync(envPath, "utf-8")
  : "";

for (const [key, value] of Object.entries(lines)) {
  const line = `${key}=${value}`;
  content = content
    ? replaceOrAppend(content, key, line)
    : line;
}

fs.writeFileSync(envPath, content.trimEnd() + "\n");
console.log(`\n${green("Successfully saved to:")} ${envPath}`);
console.log(`
${bold("Next Steps:")}
1. Fund the Viewer wallet (${cyan(buyer.address)}) with USDC via Circle Faucet:
   https://faucet.circle.com/ (Select Arc Testnet)
2. Run the application backend and frontend portals to begin streaming payments!
`);
