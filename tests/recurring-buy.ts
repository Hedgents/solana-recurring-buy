import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { assert } from "chai";
import { RecurringBuyKeeper } from "../keeper/keeper";

// Programs are loaded from the generated IDLs (program id lives in idl.address),
// which avoids any workspace-name casing ambiguity.
const rbIdl = require("../target/idl/recurring_buy.json");
const msIdl = require("../target/idl/mock_swap.json");

const CONFIG_SEED = Buffer.from("config");
const BUY_AUTH_SEED = Buffer.from("buy");
const POOL_SEED = Buffer.from("pool");

// $1.00 per target token, 6 decimals, 1% max slippage floor.
const PRICE_REF_MICROS = new anchor.BN(1_000_000);
const MAX_SLIPPAGE_BPS = 100;
const USDC_DECIMALS = 6;
const TARGET_DECIMALS = 6;

describe("recurring-buy: non-custodial recurring buy invariants", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const rb = new anchor.Program(rbIdl, provider);
  const ms = new anchor.Program(msIdl, provider);

  let usdcMint: PublicKey;
  let targetMint: PublicKey;
  let config: PublicKey;
  let poolAuthority: PublicKey;
  let poolUsdc: PublicKey;
  let poolTarget: PublicKey;

  // A fresh subscriber per test keeps transient/dest state isolated.
  async function createAta(mint: PublicKey, owner: PublicKey, offcurve = false): Promise<PublicKey> {
    const ata = getAssociatedTokenAddressSync(mint, owner, offcurve);
    const ix = createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint);
    await provider.sendAndConfirm(new Transaction().add(ix), []);
    return ata;
  }

  function buyAuthPda(user: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync([BUY_AUTH_SEED, user.toBuffer()], rb.programId)[0];
  }

  // Stand up a fresh subscriber: transient USDC ATA (the native pull's sink) and
  // the user's own target ATA (the only allowed destination).
  async function newSubscriber(fundUsdc: number) {
    const user = Keypair.generate();
    const buyAuth = buyAuthPda(user.publicKey);
    const transient = await createAta(usdcMint, buyAuth, true);
    const dest = await createAta(targetMint, user.publicKey);
    if (fundUsdc > 0) await mintTo(connection, payer, usdcMint, transient, payer, fundUsdc);
    return { user, buyAuth, transient, dest };
  }

  // Build the mock-swap instruction the keeper would supply, and return its
  // (data, keys) so execute_buy can forward + verify it.
  async function buildSwap(transient: PublicKey, buyAuth: PublicKey, dest: PublicKey, amountIn: number, outAmount: number) {
    const ix = await ms.methods
      .swap(new anchor.BN(amountIn), new anchor.BN(outAmount))
      .accounts({
        sourceUsdc: transient,
        sourceAuthority: buyAuth,
        poolUsdc,
        poolTarget,
        destTarget: dest,
        poolAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    return { data: ix.data as Buffer, keys: ix.keys };
  }

  async function executeBuy(sub: any, minOut: number, swap: any, swapProgram = ms.programId) {
    return rb.methods
      .executeBuy(new anchor.BN(minOut), swap.data)
      .accounts({
        keeper: payer.publicKey,
        config,
        user: sub.user.publicKey,
        buyAuthority: sub.buyAuth,
        transientUsdc: sub.transient,
        destAta: sub.dest,
        swapProgram,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(swap.keys)
      .rpc();
  }

  const bal = async (ata: PublicKey) => Number((await getAccount(connection, ata)).amount);

  before(async () => {
    usdcMint = await createMint(connection, payer, payer.publicKey, null, USDC_DECIMALS);
    targetMint = await createMint(connection, payer, payer.publicKey, null, TARGET_DECIMALS);

    config = PublicKey.findProgramAddressSync([CONFIG_SEED], rb.programId)[0];
    poolAuthority = PublicKey.findProgramAddressSync([POOL_SEED], ms.programId)[0];

    // Fund the mock pool with target tokens to sell.
    poolUsdc = await createAta(usdcMint, poolAuthority, true);
    poolTarget = await createAta(targetMint, poolAuthority, true);
    await mintTo(connection, payer, targetMint, poolTarget, payer, 1_000_000_000_000);

    await rb.methods
      .initConfig([ms.programId], PRICE_REF_MICROS, MAX_SLIPPAGE_BPS)
      .accounts({
        admin: payer.publicKey,
        config,
        targetMint,
        usdcMint,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
  });

  it("happy path: pulls, swaps, delivers to the user; transient drains to zero", async () => {
    const sub = await newSubscriber(10_000_000); // $10 pulled
    const swap = await buildSwap(sub.transient, sub.buyAuth, sub.dest, 10_000_000, 10_000_000);
    await executeBuy(sub, 9_900_000, swap);

    assert.equal(await bal(sub.transient), 0, "transient must drain to zero (INV-3)");
    assert.equal(await bal(sub.dest), 10_000_000, "user received the target asset");
  });

  it("INV-2 floor: rejects min_out below the price-sanity floor", async () => {
    const sub = await newSubscriber(10_000_000);
    const swap = await buildSwap(sub.transient, sub.buyAuth, sub.dest, 10_000_000, 10_000_000);
    try {
      await executeBuy(sub, 9_000_000, swap); // floor is 9_900_000
      assert.fail("should have reverted");
    } catch (e: any) {
      assert.equal(e.error?.errorCode?.code, "MinOutTooLow");
    }
    assert.equal(await bal(sub.transient), 10_000_000, "funds untouched on revert");
  });

  it("INV-2 slippage: rejects when realized output is below min_out", async () => {
    const sub = await newSubscriber(10_000_000);
    const swap = await buildSwap(sub.transient, sub.buyAuth, sub.dest, 10_000_000, 9_500_000); // underpays
    try {
      await executeBuy(sub, 9_900_000, swap);
      assert.fail("should have reverted");
    } catch (e: any) {
      assert.equal(e.error?.errorCode?.code, "SlippageExceeded");
    }
    assert.equal(await bal(sub.dest), 0, "no delivery on revert (atomic)");
  });

  it("INV-1: rejects a destination not owned by the subscriber", async () => {
    const sub = await newSubscriber(10_000_000);
    const attacker = Keypair.generate();
    const attackerDest = await createAta(targetMint, attacker.publicKey);
    // Point both the swap output and execute_buy destination at the attacker.
    const swap = await buildSwap(sub.transient, sub.buyAuth, attackerDest, 10_000_000, 10_000_000);
    try {
      await rb.methods
        .executeBuy(new anchor.BN(9_900_000), swap.data)
        .accounts({
          keeper: payer.publicKey,
          config,
          user: sub.user.publicKey,
          buyAuthority: sub.buyAuth,
          transientUsdc: sub.transient,
          destAta: attackerDest,
          swapProgram: ms.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(swap.keys)
        .rpc();
      assert.fail("should have reverted");
    } catch (e: any) {
      assert.equal(e.error?.errorCode?.code, "DestinationNotOwner");
    }
  });

  it("INV-4: rejects a non-whitelisted swap venue", async () => {
    const sub = await newSubscriber(10_000_000);
    const swap = await buildSwap(sub.transient, sub.buyAuth, sub.dest, 10_000_000, 10_000_000);
    try {
      await executeBuy(sub, 9_900_000, swap, Keypair.generate().publicKey); // random venue
      assert.fail("should have reverted");
    } catch (e: any) {
      assert.equal(e.error?.errorCode?.code, "VenueNotWhitelisted");
    }
  });

  it("INV-3: rejects when the swap leaves residue in the transient", async () => {
    const sub = await newSubscriber(10_000_000);
    // Mock only swaps 6 of the 10 pulled -> 4 USDC residue remains.
    const swap = await buildSwap(sub.transient, sub.buyAuth, sub.dest, 6_000_000, 10_000_000);
    try {
      await executeBuy(sub, 9_900_000, swap);
      assert.fail("should have reverted");
    } catch (e: any) {
      assert.equal(e.error?.errorCode?.code, "TransientNotDrained");
    }
    assert.equal(await bal(sub.transient), 10_000_000, "funds untouched on revert");
  });

  it("keeper composes and lands a buy end-to-end (mock venue)", async () => {
    const sub = await newSubscriber(10_000_000); // stand-in for the native pull
    const swap = await buildSwap(sub.transient, sub.buyAuth, sub.dest, 10_000_000, 10_000_000);
    const keeper = new RecurringBuyKeeper(rb, { usdcMint, targetMint });
    const execIx = await keeper.buildExecuteBuy({
      user: sub.user.publicKey,
      keeper: payer.publicKey,
      minOut: new anchor.BN(9_900_000),
      swap: { program: ms.programId, data: swap.data, keys: swap.keys },
    });
    const sig = await keeper.composeAndSend({
      connection,
      payer,
      ixs: [keeper.ensureTransientIx(sub.user.publicKey, payer.publicKey), execIx],
    });
    assert.ok(sig, "keeper submitted the composed tx");
    assert.equal(await bal(sub.transient), 0, "transient drained via keeper");
    assert.equal(await bal(sub.dest), 10_000_000, "user received target via keeper");
  });

  it("INV-2 floor is MANDATORY: refuses when price_ref is unconfigured (0)", async () => {
    await rb.methods.setParams(new anchor.BN(0), MAX_SLIPPAGE_BPS)
      .accounts({ admin: payer.publicKey, config }).rpc();
    const sub = await newSubscriber(10_000_000);
    const swap = await buildSwap(sub.transient, sub.buyAuth, sub.dest, 10_000_000, 10_000_000);
    try {
      await executeBuy(sub, 1, swap); // min_out=1 would be theft if the floor were optional
      assert.fail("should have reverted");
    } catch (e: any) {
      assert.equal(e.error?.errorCode?.code, "FloorNotConfigured");
    }
    assert.equal(await bal(sub.transient), 10_000_000, "funds untouched on revert");
    await rb.methods.setParams(PRICE_REF_MICROS, MAX_SLIPPAGE_BPS)
      .accounts({ admin: payer.publicKey, config }).rpc();
  });

  it("admin-only: a non-admin cannot change params", async () => {
    const intruder = Keypair.generate();
    try {
      await rb.methods.setParams(new anchor.BN(1), 1)
        .accounts({ admin: intruder.publicKey, config }).signers([intruder]).rpc();
      assert.fail("should have reverted");
    } catch (e: any) {
      assert.ok(e, "non-admin rejected");
    }
  });

  it("pause halts execution", async () => {
    await rb.methods.setPause(true).accounts({ admin: payer.publicKey, config }).rpc();
    const sub = await newSubscriber(10_000_000);
    const swap = await buildSwap(sub.transient, sub.buyAuth, sub.dest, 10_000_000, 10_000_000);
    try {
      await executeBuy(sub, 9_900_000, swap);
      assert.fail("should have reverted");
    } catch (e: any) {
      assert.equal(e.error?.errorCode?.code, "Paused");
    }
    await rb.methods.setPause(false).accounts({ admin: payer.publicKey, config }).rpc();
  });
});
