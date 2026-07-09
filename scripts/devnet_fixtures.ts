/**
 * Devnet fixtures + live router smoke.
 * Idempotent: creates mock USDC + target mints, inits config, funds a mock pool,
 * runs one execute_buy through the mock venue (minted-transient stand-in for the
 * native pull) to prove the router on real devnet, and writes .devnet.json for
 * the kit e2e (which adds the REAL native subscription pull).
 *
 * Run:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=$HOME/.config/solana/id.json \
 *   ./node_modules/.bin/ts-mocha -p ./tsconfig.json -t 1000000 scripts/devnet_fixtures.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createMint, mintTo, getAccount, getMint,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { assert } from "chai";
import { writeFileSync } from "fs";
import { RecurringBuyKeeper } from "../keeper/keeper";

const rbIdl = require("../target/idl/recurring_buy.json");
const msIdl = require("../target/idl/mock_swap.json");

const CONFIG_SEED = Buffer.from("config");
const POOL_SEED = Buffer.from("pool");
const PRICE_REF_MICROS = new anchor.BN(1_000_000); // $1.00 per target token
const MAX_SLIPPAGE_BPS = 100;

describe("devnet fixtures + router smoke", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const rb = new anchor.Program(rbIdl, provider);
  const ms = new anchor.Program(msIdl, provider);

  const config = PublicKey.findProgramAddressSync([CONFIG_SEED], rb.programId)[0];
  const poolAuthority = PublicKey.findProgramAddressSync([POOL_SEED], ms.programId)[0];

  const bal = async (a: PublicKey) => Number((await getAccount(connection, a)).amount);
  async function createAtaIx(mint: PublicKey, owner: PublicKey, offcurve = false) {
    const ata = getAssociatedTokenAddressSync(mint, owner, offcurve);
    return { ata, ix: createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, mint) };
  }

  it("sets up (idempotent) and lands a live devnet buy", async () => {
    let usdcMint: PublicKey, targetMint: PublicKey;
    const existing = await connection.getAccountInfo(config);
    if (existing) {
      const cfg: any = await (rb.account as any).config.fetch(config);
      usdcMint = cfg.usdcMint; targetMint = cfg.targetMint;
      console.log("config exists; reusing mints");
    } else {
      usdcMint = await createMint(connection, payer, payer.publicKey, null, 6);
      targetMint = await createMint(connection, payer, payer.publicKey, null, 6);
      await rb.methods.initConfig([ms.programId], PRICE_REF_MICROS, MAX_SLIPPAGE_BPS)
        .accounts({ admin: payer.publicKey, config, targetMint, usdcMint,
          systemProgram: anchor.web3.SystemProgram.programId }).rpc();
      console.log("created mints + config");
    }

    // Mock pool: fund target liquidity (idempotent create + top up).
    const { ata: poolUsdc, ix: mkPoolUsdc } = await createAtaIx(usdcMint, poolAuthority, true);
    const { ata: poolTarget, ix: mkPoolTarget } = await createAtaIx(targetMint, poolAuthority, true);
    await provider.sendAndConfirm(new Transaction().add(mkPoolUsdc, mkPoolTarget), []);
    let poolBal = 0; try { poolBal = await bal(poolTarget); } catch {}
    if (poolBal < 100_000_000) await mintTo(connection, payer, targetMint, poolTarget, payer, 1_000_000_000_000);

    const keeper = new RecurringBuyKeeper(rb, { usdcMint, targetMint });
    const buyAuth = keeper.buyAuthority(payer.publicKey);
    const transient = keeper.transientUsdc(payer.publicKey);
    const dest = keeper.destAta(payer.publicKey);

    // Ensure deployer USDC ATA (native-pull source, for the kit e2e) + transient + dest.
    const { ata: deployerUsdc, ix: mkDeployerUsdc } = await createAtaIx(usdcMint, payer.publicKey);
    const { ix: mkDest } = await createAtaIx(targetMint, payer.publicKey);
    await provider.sendAndConfirm(new Transaction().add(
      mkDeployerUsdc, mkDest, keeper.ensureTransientIx(payer.publicKey, payer.publicKey)), []);
    let du = 0; try { du = await bal(deployerUsdc); } catch {}
    if (du < 50_000_000) await mintTo(connection, payer, usdcMint, deployerUsdc, payer, 100_000_000);

    // Live router smoke: mint into transient (stand-in for the native pull) then execute_buy.
    const before = await bal(dest);
    await mintTo(connection, payer, usdcMint, transient, payer, 10_000_000);
    const swap = await ms.methods.swap(new anchor.BN(10_000_000), new anchor.BN(10_000_000))
      .accounts({ sourceUsdc: transient, sourceAuthority: buyAuth, poolUsdc, poolTarget,
        destTarget: dest, poolAuthority, tokenProgram: TOKEN_PROGRAM_ID }).instruction();
    const execIx = await keeper.buildExecuteBuy({ user: payer.publicKey, keeper: payer.publicKey,
      minOut: new anchor.BN(9_900_000), swap: { program: ms.programId, data: swap.data, keys: swap.keys } });
    const sig = await keeper.composeAndSend({ connection, payer, ixs: [execIx] });
    console.log("devnet execute_buy:", sig);
    assert.equal(await bal(transient), 0, "transient drained on devnet");
    assert.equal(await bal(dest), before + 10_000_000, "target delivered on devnet");

    const out = {
      cluster: "devnet",
      recurringBuy: rb.programId.toBase58(), mockSwap: ms.programId.toBase58(),
      config: config.toBase58(), usdcMint: usdcMint.toBase58(), targetMint: targetMint.toBase58(),
      poolAuthority: poolAuthority.toBase58(), poolUsdc: poolUsdc.toBase58(), poolTarget: poolTarget.toBase58(),
      deployer: payer.publicKey.toBase58(), deployerUsdc: deployerUsdc.toBase58(),
      buyAuthority: buyAuth.toBase58(), transient: transient.toBase58(), dest: dest.toBase58(),
      priceRefMicros: PRICE_REF_MICROS.toNumber(), maxSlippageBps: MAX_SLIPPAGE_BPS,
    };
    writeFileSync(`${__dirname}/.devnet.json`, JSON.stringify(out, null, 2));
    console.log("wrote scripts/.devnet.json");
  });
});
