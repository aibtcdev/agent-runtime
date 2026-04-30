/**
 * alb-register.ts — one-shot registration of an agent on agentslovebitcoin.com.
 *
 * Self-contained Bun TS so the SIP-018 sign happens in the same process that
 * unlocked the wallet (sip018-sign CLI doesn't expose --wallet-password-env yet).
 * BIP-322 BTC sig is delegated to the existing signing CLI (which does support env unlock).
 *
 * Run from inside ~/.claude/skills/skills-repo/ on the agent VM. Requires:
 *   - CREDENTIALS_PASSWORD env (sourced from ~/.env)
 *   - A wallet-password credential in the credential store
 *   - Optional: ALB_ADMIN_KEY env to bypass the Genesis gate via X-Admin-Key
 *
 * Output: JSON envelope { http_code, btc, stx, body }.
 */

import {
  signStructuredData,
  tupleCV,
  stringAsciiCV,
  uintCV,
} from "@stacks/transactions";
import { getWalletManager } from "./src/lib/services/wallet-manager.js";
import { getCredential } from "./credentials/store.js";
import { spawnSync } from "node:child_process";

const ALB_BASE = process.env.ALB_BASE ?? "https://agentslovebitcoin.com";

async function main(): Promise<void> {
  const credPassword = process.env.CREDENTIALS_PASSWORD;
  if (!credPassword) throw new Error("CREDENTIALS_PASSWORD must be set (source ~/.env first)");

  const walletCred = await getCredential("wallet-password", credPassword);
  const walletPassword = walletCred.value;

  const walletManager = getWalletManager();
  const walletId = await walletManager.getActiveWalletId();
  if (!walletId) throw new Error("No active wallet found");

  const account = await walletManager.unlock(walletId, walletPassword);
  try {
    const btc = account.btcAddress;
    const stx = account.address;
    if (!btc?.startsWith("bc1q")) throw new Error(`wallet BTC must be P2WPKH (bc1q): ${btc}`);
    if (!stx?.startsWith("SP")) throw new Error(`wallet STX must be mainnet (SP): ${stx}`);

    const ts = Math.floor(Date.now() / 1000);
    const message = `REGISTER ${btc}:${stx}:${ts}`;

    // BTC: shell out to signing/signing.ts btc-sign — its CLI honors AIBTC_WALLET_PASSWORD env.
    const btcSig = runBtcSign(message, walletPassword);

    // STX: SIP-018 inline (uses the already-unlocked account.privateKey).
    const messageCV = tupleCV({
      action: stringAsciiCV("register"),
      "btc-address": stringAsciiCV(btc),
      "stx-address": stringAsciiCV(stx),
      timestamp: uintCV(ts),
    });
    const domainCV = tupleCV({
      name: stringAsciiCV("agentslovebitcoin.com"),
      version: stringAsciiCV("1"),
      "chain-id": uintCV(1),
    });
    const stxSig = signStructuredData({
      message: messageCV,
      domain: domainCV,
      privateKey: account.privateKey,
    });

    const headers: Record<string, string> = {
      "X-BTC-Address": btc,
      "X-BTC-Signature": btcSig,
      "X-BTC-Timestamp": String(ts),
      "X-STX-Address": stx,
      "X-STX-Signature": stxSig,
    };
    if (process.env.ALB_ADMIN_KEY) headers["X-Admin-Key"] = process.env.ALB_ADMIN_KEY;

    const resp = await fetch(`${ALB_BASE}/api/register`, { method: "POST", headers });
    const text = await resp.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch {}

    console.log(JSON.stringify({ http_code: resp.status, btc, stx, body }, null, 2));
  } finally {
    walletManager.lock();
  }
}

function runBtcSign(message: string, walletPassword: string): string {
  const result = spawnSync(
    "bun",
    ["run", "signing/signing.ts", "btc-sign", "--message", message, "--wallet-password", walletPassword],
    { encoding: "utf8", env: { ...process.env, AIBTC_WALLET_PASSWORD: walletPassword } }
  );
  if (result.status !== 0) {
    throw new Error(`btc-sign failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout) as { signatureBase64?: string; error?: string };
  if (parsed.error) throw new Error(`btc-sign error: ${parsed.error}`);
  if (!parsed.signatureBase64) throw new Error("btc-sign returned no signatureBase64");
  return parsed.signatureBase64;
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
