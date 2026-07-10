/**
 * Devnet M2 sell setup (idempotent). Reads scripts/.devnet.json (written by
 * devnet_fixtures.ts), then: funds the mock pool's USDC side, ensures the
 * sell-side ATAs, tops up the deployer's target pot, and (re)opens a fresh
 * SellPlan so the first sell is immediately due. Appends sell fields to
 * .devnet.json for keeper/native/e2e_sell.mjs.
 *
 * Run:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=$HOME/.config/solana/id.json \
 *   ./node_modules/.bin/ts-mocha -p ./tsconfig.json -t 1000000 scripts/devnet_sell_setup.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  mintTo, getAccount, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { assert } from "chai";
import { readFileSync, writeFileSync } from "fs";

const rbIdl = require("../target/idl/recurring_buy.json");

const SELL_PLAN_SEED = Buffer.from("sell-plan");
const PERIOD_SECS = 3600; // 1h cadence on devnet
const PERIODS = 10;

describe("devnet M2 sell setup", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const rb = new anchor.Program(rbIdl, provider);

  it("prepares the sell-side fixtures + a fresh plan", async () => {
    const F = JSON.parse(readFileSync(`${__dirname}/.devnet.json`, "utf8"));
    const usdcMint = new PublicKey(F.usdcMint);
    const targetMint = new PublicKey(F.targetMint);
    const buyAuth = new PublicKey(F.buyAuthority);
    const poolUsdc = new PublicKey(F.poolUsdc);

    // Pool must hold USDC to pay out on sells.
    let pu = 0; try { pu = Number((await getAccount(connection, poolUsdc)).amount); } catch {}
    if (pu < 100_000_000) await mintTo(connection, payer, usdcMint, poolUsdc, payer, 1_000_000_000_000);

    // Sell-side transient (target-mint ATA of the same per-user PDA).
    const transientTarget = getAssociatedTokenAddressSync(targetMint, buyAuth, true);
    await provider.sendAndConfirm(new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, transientTarget, buyAuth, targetMint)
    ), []);

    // Pot: the deployer's own target ATA (exists from the buy e2e; top up).
    const userTarget = new PublicKey(F.dest);
    let pot = Number((await getAccount(connection, userTarget)).amount);
    if (pot < 40_000_000) {
      await mintTo(connection, payer, targetMint, userTarget, payer, 40_000_000 - pot);
      pot = 40_000_000;
    }

    // Fresh plan: close a stale one first so next_due_ts resets to now.
    const plan = PublicKey.findProgramAddressSync(
      [SELL_PLAN_SEED, payer.publicKey.toBuffer()], rb.programId)[0];
    if (await connection.getAccountInfo(plan)) {
      await rb.methods.closeSellPlan()
        .accountsPartial({ user: payer.publicKey, sellPlan: plan }).rpc();
      console.log("closed stale plan");
    }
    const now = Math.floor(Date.now() / 1000);
    const endTs = now + PERIODS * PERIOD_SECS + 60;
    await rb.methods.openSellPlan(new anchor.BN(endTs), new anchor.BN(PERIOD_SECS))
      .accountsPartial({ user: payer.publicKey, sellPlan: plan }).rpc();
    console.log("opened plan:", plan.toBase58(), "end:", endTs, "pot:", pot);

    const out = {
      ...F,
      sellPlan: plan.toBase58(),
      transientTarget: transientTarget.toBase58(),
      userTargetAta: userTarget.toBase58(),
      destUsdcAta: F.deployerUsdc,
      sellEndTs: endTs, sellPeriodSecs: PERIOD_SECS, potAtSetup: pot,
    };
    writeFileSync(`${__dirname}/.devnet.json`, JSON.stringify(out, null, 2));
    assert.ok(pot > 0);
    console.log("wrote sell fields to scripts/.devnet.json");
  });
});
