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
const FEE_CONFIG_SEED = Buffer.from("fee");
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
  let feeConfig: PublicKey;
  let feeUsdcAta: PublicKey;
  let feeTargetAta: PublicKey;
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
        feeConfig,
        feeAta: feeUsdcAta,
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

    // Protocol fee: config PDA (default 0 bps) + the destination's canonical ATAs.
    feeConfig = PublicKey.findProgramAddressSync([FEE_CONFIG_SEED], rb.programId)[0];
    feeUsdcAta = await createAta(usdcMint, payer.publicKey);
    feeTargetAta = await createAta(targetMint, payer.publicKey);
    await rb.methods.initFeeConfig(0, payer.publicKey)
      .accountsPartial({ admin: payer.publicKey, config, feeConfig }).rpc();
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
          feeConfig,
          feeAta: feeUsdcAta,
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

  describe("M2: amortized decumulation (execute_sell)", () => {
    const SELL_PLAN_SEED = Buffer.from("sell-plan");
    const PERIOD = 60; // MIN_PERIOD_SECS
    const sellPlanPda = (user: PublicKey) =>
      PublicKey.findProgramAddressSync([SELL_PLAN_SEED, user.toBuffer()], rb.programId)[0];

    // A retiree: pot of target tokens in their own ATA, a transient target ATA
    // (the native pull's sink), and a USDC ATA for proceeds.
    async function newRetiree(potTarget: number, pulledTarget: number) {
      const user = Keypair.generate();
      const buyAuth = buyAuthPda(user.publicKey);
      const transientTarget = await createAta(targetMint, buyAuth, true);
      const userTarget = await createAta(targetMint, user.publicKey);
      const destUsdc = await createAta(usdcMint, user.publicKey);
      if (potTarget > 0) await mintTo(connection, payer, targetMint, userTarget, payer, potTarget);
      if (pulledTarget > 0) await mintTo(connection, payer, targetMint, transientTarget, payer, pulledTarget);
      // fund the user so they can sign open/close
      await provider.sendAndConfirm(
        new Transaction().add(
          anchor.web3.SystemProgram.transfer({
            fromPubkey: payer.publicKey, toPubkey: user.publicKey, lamports: 100_000_000,
          })
        ), []);
      return { user, buyAuth, transientTarget, userTarget, destUsdc, plan: sellPlanPda(user.publicKey) };
    }

    async function openPlan(r: any, periods: number) {
      const now = Math.floor(Date.now() / 1000);
      await rb.methods
        .openSellPlan(new anchor.BN(now + periods * PERIOD + 5), new anchor.BN(PERIOD))
        .accountsPartial({ user: r.user.publicKey, sellPlan: r.plan })
        .signers([r.user])
        .rpc();
    }

    // The mock venue reversed: source = transient TARGET, pool receives target,
    // pool pays USDC to the user's USDC ATA.
    async function buildSellSwap(r: any, amountIn: number, outUsdc: number) {
      const ix = await ms.methods
        .swap(new anchor.BN(amountIn), new anchor.BN(outUsdc))
        .accounts({
          sourceUsdc: r.transientTarget,
          sourceAuthority: r.buyAuth,
          poolUsdc: poolTarget,   // receives the sold target tokens
          poolTarget: poolUsdc,   // pays USDC out of the pool
          destTarget: r.destUsdc,
          poolAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      return { data: ix.data as Buffer, keys: ix.keys };
    }

    async function executeSell(r: any, minOut: number, swap: any) {
      return rb.methods
        .executeSell(new anchor.BN(minOut), swap.data)
        .accounts({
          keeper: payer.publicKey,
          config,
          user: r.user.publicKey,
          sellPlan: r.plan,
          buyAuthority: r.buyAuth,
          transientTarget: r.transientTarget,
          userTargetAta: r.userTarget,
          destUsdc: r.destUsdc,
          swapProgram: ms.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          feeConfig,
          feeAta: feeTargetAta,
        })
        .remainingAccounts(swap.keys)
        .rpc();
    }

    before(async () => {
      // The sell direction pays USDC out of the pool: fund it.
      await mintTo(connection, payer, usdcMint, poolUsdc, payer, 1_000_000_000_000);
    });

    it("sell happy path: amortized draw -> USDC to the user, transient drains, clock advances", async () => {
      const r = await newRetiree(90_000_000, 10_000_000); // pot 100 total, 10 pulled
      await openPlan(r, 10); // cap ~ 100/9..10 >= 10
      const swap = await buildSellSwap(r, 10_000_000, 10_000_000); // $1/token
      await executeSell(r, 9_900_000, swap);

      assert.equal(await bal(r.transientTarget), 0, "transient drained (INV-3)");
      assert.equal(await bal(r.destUsdc), 10_000_000, "USDC delivered to the user");
      const plan: any = await (rb.account as any).sellPlan.fetch(r.plan);
      assert.ok(plan.nextDueTs.toNumber() > Math.floor(Date.now() / 1000), "clock gate advanced past now");
    });

    it("M2 INV-5: rejects a pull exceeding the amortized schedule cap", async () => {
      const r = await newRetiree(80_000_000, 20_000_000); // pot 100, cap ~ 100/9..10 < 20
      await openPlan(r, 10);
      const swap = await buildSellSwap(r, 20_000_000, 20_000_000);
      try {
        await executeSell(r, 19_800_000, swap);
        assert.fail("should have reverted");
      } catch (e: any) {
        assert.equal(e.error?.errorCode?.code, "OverdrawSchedule");
      }
      assert.equal(await bal(r.transientTarget), 20_000_000, "funds untouched on revert");
    });

    it("M2 INV-6: second crank in the same period is NotDue", async () => {
      const r = await newRetiree(90_000_000, 10_000_000);
      await openPlan(r, 10);
      const swap1 = await buildSellSwap(r, 10_000_000, 10_000_000);
      await executeSell(r, 9_900_000, swap1);
      // refill the transient (as if pulled again) and crank immediately
      await mintTo(connection, payer, targetMint, r.transientTarget, payer, 5_000_000);
      const swap2 = await buildSellSwap(r, 5_000_000, 5_000_000);
      try {
        await executeSell(r, 4_950_000, swap2);
        assert.fail("should have reverted");
      } catch (e: any) {
        assert.equal(e.error?.errorCode?.code, "NotDue");
      }
    });

    it("INV-2 (sell): mandatory floor rejects a lowball min_out", async () => {
      const r = await newRetiree(90_000_000, 10_000_000);
      await openPlan(r, 10);
      const swap = await buildSellSwap(r, 10_000_000, 10_000_000);
      try {
        await executeSell(r, 1, swap); // floor is 9_900_000 uUSDC
        assert.fail("should have reverted");
      } catch (e: any) {
        assert.equal(e.error?.errorCode?.code, "MinOutTooLow");
      }
    });

    it("M2 INV-5 pinned: exactly cap passes, cap+1 reverts (10 periods, 55s slack)", async () => {
      // total pot 100e6, 10 periods -> cap exactly 10_000_000 while <55s elapse
      const openSlack = async (r: any) => {
        const now = Math.floor(Date.now() / 1000);
        await rb.methods
          .openSellPlan(new anchor.BN(now + 10 * PERIOD + 55), new anchor.BN(PERIOD))
          .accountsPartial({ user: r.user.publicKey, sellPlan: r.plan })
          .signers([r.user]).rpc();
      };
      const a = await newRetiree(90_000_000, 10_000_000); // pull == cap
      await openSlack(a);
      await executeSell(a, 9_900_000, await buildSellSwap(a, 10_000_000, 10_000_000));
      assert.equal(await bal(a.destUsdc), 10_000_000, "exact-cap pull succeeds");

      const b = await newRetiree(89_999_999, 10_000_001); // pull == cap + 1
      await openSlack(b);
      try {
        await executeSell(b, 9_900_000, await buildSellSwap(b, 10_000_001, 10_000_001));
        assert.fail("should have reverted");
      } catch (e: any) {
        assert.equal(e.error?.errorCode?.code, "OverdrawSchedule");
      }
    });

    it("M2 INV-1: rejects proceeds destined to a non-owner USDC account", async () => {
      const r = await newRetiree(90_000_000, 10_000_000);
      await openPlan(r, 10);
      const attacker = Keypair.generate();
      const attackerUsdc = await createAta(usdcMint, attacker.publicKey);
      const swap = await buildSellSwap({ ...r, destUsdc: attackerUsdc }, 10_000_000, 10_000_000);
      try {
        await rb.methods
          .executeSell(new anchor.BN(9_900_000), swap.data)
          .accounts({
            keeper: payer.publicKey, config, user: r.user.publicKey, sellPlan: r.plan,
            buyAuthority: r.buyAuth, transientTarget: r.transientTarget,
            userTargetAta: r.userTarget, destUsdc: attackerUsdc,
            swapProgram: ms.programId, tokenProgram: TOKEN_PROGRAM_ID,
            feeConfig, feeAta: feeTargetAta,
          })
          .remainingAccounts(swap.keys).rpc();
        assert.fail("should have reverted");
      } catch (e: any) {
        assert.equal(e.error?.errorCode?.code, "DestinationNotOwner");
      }
    });

    it("M2 INV-3: rejects when the sell leaves residue in the transient", async () => {
      const r = await newRetiree(90_000_000, 10_000_000);
      await openPlan(r, 10);
      const swap = await buildSellSwap(r, 6_000_000, 10_000_000); // swaps only 6 of 10
      try {
        await executeSell(r, 9_900_000, swap);
        assert.fail("should have reverted");
      } catch (e: any) {
        assert.equal(e.error?.errorCode?.code, "TransientNotDrained");
      }
    });

    it("M2 INV-4: rejects a non-whitelisted venue on the sell path", async () => {
      const r = await newRetiree(90_000_000, 10_000_000);
      await openPlan(r, 10);
      const swap = await buildSellSwap(r, 10_000_000, 10_000_000);
      try {
        await rb.methods
          .executeSell(new anchor.BN(9_900_000), swap.data)
          .accounts({
            keeper: payer.publicKey, config, user: r.user.publicKey, sellPlan: r.plan,
            buyAuthority: r.buyAuth, transientTarget: r.transientTarget,
            userTargetAta: r.userTarget, destUsdc: r.destUsdc,
            swapProgram: Keypair.generate().publicKey, tokenProgram: TOKEN_PROGRAM_ID,
            feeConfig, feeAta: feeTargetAta,
          })
          .remainingAccounts(swap.keys).rpc();
        assert.fail("should have reverted");
      } catch (e: any) {
        assert.equal(e.error?.errorCode?.code, "VenueNotWhitelisted");
      }
    });

    it("M2 INV-2: rejects when realized USDC is below min_out (venue underpays)", async () => {
      const r = await newRetiree(90_000_000, 10_000_000);
      await openPlan(r, 10);
      const swap = await buildSellSwap(r, 10_000_000, 9_000_000); // underpays
      try {
        await executeSell(r, 9_900_000, swap);
        assert.fail("should have reverted");
      } catch (e: any) {
        assert.equal(e.error?.errorCode?.code, "SlippageExceeded");
      }
      assert.equal(await bal(r.destUsdc), 0, "no delivery on revert (atomic)");
    });

    it("M2 INV-5: rejects a non-canonical pot account (BadPotAccount)", async () => {
      const r = await newRetiree(90_000_000, 10_000_000);
      await openPlan(r, 10);
      const swap = await buildSellSwap(r, 10_000_000, 10_000_000);
      try {
        await rb.methods
          .executeSell(new anchor.BN(9_900_000), swap.data)
          .accounts({
            keeper: payer.publicKey, config, user: r.user.publicKey, sellPlan: r.plan,
            buyAuthority: r.buyAuth, transientTarget: r.transientTarget,
            userTargetAta: r.transientTarget, // not the user's canonical target ATA
            destUsdc: r.destUsdc,
            swapProgram: ms.programId, tokenProgram: TOKEN_PROGRAM_ID,
            feeConfig, feeAta: feeTargetAta,
          })
          .remainingAccounts(swap.keys).rpc();
        assert.fail("should have reverted");
      } catch (e: any) {
        assert.equal(e.error?.errorCode?.code, "BadPotAccount");
      }
    });

    it("pause halts execute_sell too", async () => {
      await rb.methods.setPause(true).accounts({ admin: payer.publicKey, config }).rpc();
      const r = await newRetiree(90_000_000, 10_000_000);
      await openPlan(r, 10);
      const swap = await buildSellSwap(r, 10_000_000, 10_000_000);
      try {
        await executeSell(r, 9_900_000, swap);
        assert.fail("should have reverted");
      } catch (e: any) {
        assert.equal(e.error?.errorCode?.code, "Paused");
      }
      await rb.methods.setPause(false).accounts({ admin: payer.publicKey, config }).rpc();
    });

    it("M2 lifecycle: k-jump advance, late final crank, then PlanCompleted (62s)", async function () {
      this.timeout(120_000);
      // Minimum-horizon plan: one due period + a served-late tail, then terminal.
      const r = await newRetiree(0, 10_000_000); // whole pot sits in the transient
      await openPlan(r, 1); // end = now + 65s, period 60s
      await executeSell(r, 9_900_000, await buildSellSwap(r, 10_000_000, 10_000_000));
      assert.equal(await bal(r.destUsdc), 10_000_000, "crank 1 (full pot, 1 period)");

      // Same period again -> NotDue (not yet terminal: next_due <= end).
      await mintTo(connection, payer, targetMint, r.transientTarget, payer, 1_000_000);
      try {
        await executeSell(r, 990_000, await buildSellSwap(r, 1_000_000, 1_000_000));
        assert.fail("should have reverted");
      } catch (e: any) {
        assert.equal(e.error?.errorCode?.code, "NotDue");
      }

      await new Promise((res) => setTimeout(res, 62_000));

      // Final due period, served late: succeeds and advances past end_ts.
      await executeSell(r, 990_000, await buildSellSwap(r, 1_000_000, 1_000_000));
      assert.equal(await bal(r.destUsdc), 11_000_000, "late final crank served");

      // Schedule complete: the automation refuses forever.
      await mintTo(connection, payer, targetMint, r.transientTarget, payer, 1_000_000);
      try {
        await executeSell(r, 990_000, await buildSellSwap(r, 1_000_000, 1_000_000));
        assert.fail("should have reverted");
      } catch (e: any) {
        assert.equal(e.error?.errorCode?.code, "PlanCompleted");
      }
    });

    it("open rejects a sub-minimum period; close returns rent to the owner", async () => {
      const r = await newRetiree(0, 0);
      const now = Math.floor(Date.now() / 1000);
      try {
        await rb.methods
          .openSellPlan(new anchor.BN(now + 3600), new anchor.BN(30)) // 30s < MIN_PERIOD_SECS
          .accountsPartial({ user: r.user.publicKey, sellPlan: r.plan })
          .signers([r.user])
          .rpc();
        assert.fail("should have reverted");
      } catch (e: any) {
        assert.equal(e.error?.errorCode?.code, "BadParam");
      }
      await openPlan(r, 10);
      await rb.methods
        .closeSellPlan()
        .accountsPartial({ user: r.user.publicKey, sellPlan: r.plan })
        .signers([r.user])
        .rpc();
      const gone = await connection.getAccountInfo(r.plan);
      assert.isNull(gone, "plan account closed");
    });
  });

  describe("protocol fee (fixed bps of flow, capped, default 0)", () => {
    const SELL_PLAN_SEED = Buffer.from("sell-plan");
    const setFee = (bps: number) =>
      rb.methods.setFee(bps, payer.publicKey)
        .accountsPartial({ admin: payer.publicKey, config, feeConfig }).rpc();

    it("buy skims the fee to the destination ATA; user gets the net", async () => {
      await setFee(50); // 0.50%
      const feeBefore = await bal(feeUsdcAta);
      const sub = await newSubscriber(10_000_000);
      // fee = 50_000, net = 9_950_000; venue swaps the net 1:1
      const swap = await buildSwap(sub.transient, sub.buyAuth, sub.dest, 9_950_000, 9_950_000);
      await executeBuy(sub, 9_850_500, swap); // floor over NET = 9_950_000 * 0.99
      assert.equal(await bal(sub.dest), 9_950_000, "user received the NET");
      assert.equal(await bal(feeUsdcAta), feeBefore + 50_000, "fee skimmed to destination");
      assert.equal(await bal(sub.transient), 0, "transient still drains to zero");
      await setFee(0);
    });

    it("sell skims the fee in kind; proceeds cover the net", async () => {
      await setFee(50);
      const feeBefore = await bal(feeTargetAta);
      const user = Keypair.generate();
      const buyAuth = buyAuthPda(user.publicKey);
      const transientTarget = await createAta(targetMint, buyAuth, true);
      const userTarget = await createAta(targetMint, user.publicKey);
      const destUsdc = await createAta(usdcMint, user.publicKey);
      await mintTo(connection, payer, targetMint, userTarget, payer, 90_000_000);
      await mintTo(connection, payer, targetMint, transientTarget, payer, 10_000_000);
      await provider.sendAndConfirm(new Transaction().add(
        anchor.web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: user.publicKey, lamports: 100_000_000 })
      ), []);
      const plan = PublicKey.findProgramAddressSync([SELL_PLAN_SEED, user.publicKey.toBuffer()], rb.programId)[0];
      const now = Math.floor(Date.now() / 1000);
      await rb.methods.openSellPlan(new anchor.BN(now + 10 * 60 + 55), new anchor.BN(60))
        .accountsPartial({ user: user.publicKey, sellPlan: plan }).signers([user]).rpc();
      // fee = 50_000 target, net = 9_950_000 swapped 1:1 to USDC
      const swapIx = await ms.methods.swap(new anchor.BN(9_950_000), new anchor.BN(9_950_000))
        .accounts({ sourceUsdc: transientTarget, sourceAuthority: buyAuth, poolUsdc: poolTarget,
          poolTarget: poolUsdc, destTarget: destUsdc, poolAuthority, tokenProgram: TOKEN_PROGRAM_ID })
        .instruction();
      await rb.methods.executeSell(new anchor.BN(9_850_500), swapIx.data)
        .accounts({ keeper: payer.publicKey, config, user: user.publicKey, sellPlan: plan,
          buyAuthority: buyAuth, transientTarget, userTargetAta: userTarget, destUsdc,
          swapProgram: ms.programId, tokenProgram: TOKEN_PROGRAM_ID,
          feeConfig, feeAta: feeTargetAta })
        .remainingAccounts(swapIx.keys).rpc();
      assert.equal(await bal(destUsdc), 9_950_000, "user received NET proceeds");
      assert.equal(await bal(feeTargetAta), feeBefore + 50_000, "fee skimmed in kind");
      assert.equal(await bal(transientTarget), 0, "transient drains to zero");
      await setFee(0);
    });

    it("set_fee enforces the compiled-in cap and admin gating", async () => {
      try {
        await setFee(101);
        assert.fail("should have reverted");
      } catch (e: any) {
        assert.equal(e.error?.errorCode?.code, "FeeTooHigh");
      }
      const intruder = Keypair.generate();
      try {
        await rb.methods.setFee(10, intruder.publicKey)
          .accountsPartial({ admin: intruder.publicKey, config, feeConfig })
          .signers([intruder]).rpc();
        assert.fail("should have reverted");
      } catch (e: any) {
        assert.ok(e, "non-admin rejected");
      }
    });

    it("rejects a non-canonical fee account (BadFeeAccount)", async () => {
      await setFee(50);
      const sub = await newSubscriber(10_000_000);
      const swap = await buildSwap(sub.transient, sub.buyAuth, sub.dest, 9_950_000, 9_950_000);
      try {
        await rb.methods.executeBuy(new anchor.BN(9_850_500), swap.data)
          .accounts({ keeper: payer.publicKey, config, user: sub.user.publicKey,
            buyAuthority: sub.buyAuth, transientUsdc: sub.transient, destAta: sub.dest,
            swapProgram: ms.programId, tokenProgram: TOKEN_PROGRAM_ID,
            feeConfig, feeAta: sub.transient }) // not the destination's canonical USDC ATA
          .remainingAccounts(swap.keys).rpc();
        assert.fail("should have reverted");
      } catch (e: any) {
        assert.equal(e.error?.errorCode?.code, "BadFeeAccount");
      }
      await setFee(0);
    });
  });
});
