/**
 * RecurringBuyKeeper
 * -----------------
 * Composes the non-custodial recurring buy into a SINGLE transaction:
 *
 *   [ ensure transient ATA ] [ native transfer_recurring (pull) ] [ swap route ] [ execute_buy ]
 *
 * The keeper is a TRIGGER, not a custodian: it signs and pays fees, but every
 * account it can touch is bounded by the on-chain program (see SPEC.md ss.6).
 * It cannot redirect a user's funds, over-pull (the native subscription caps
 * that), or underprice the buy (the router's min_out floor caps that).
 *
 * Two legs are pluggable:
 *   - PULL:  the native Subscriptions & Allowances `transfer_recurring`. Proven
 *            interface (program De1egA..). On localnet, where the native program
 *            is not deployed, tests substitute a faucet mint into the transient.
 *   - SWAP:  the venue route. `buildMockSwap` (localnet/tests) or `buildJupiterSwap`
 *            (devnet/mainnet). The router forwards ONE swap instruction under the
 *            transient PDA's signature and verifies the outcome.
 */
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  TransactionInstruction,
  AccountMeta,
  Connection,
  Keypair,
  VersionedTransaction,
  TransactionMessage,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";

/** Native Subscriptions & Allowances program (mainnet + devnet). */
export const SUBSCRIPTIONS_PROGRAM = new PublicKey(
  "De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44"
);

const CONFIG_SEED = Buffer.from("config");
const BUY_AUTH_SEED = Buffer.from("buy");

export interface SwapLeg {
  /** The whitelisted venue program to CPI. */
  program: PublicKey;
  /** The venue instruction data the router forwards verbatim. */
  data: Buffer;
  /** The venue's accounts, in the order the venue expects them. */
  keys: AccountMeta[];
  /** Optional address lookup tables (Jupiter routes need them). */
  luts?: AddressLookupTableAccount[];
}

export class RecurringBuyKeeper {
  readonly program: anchor.Program;
  readonly config: PublicKey;
  readonly usdcMint: PublicKey;
  readonly targetMint: PublicKey;

  constructor(program: anchor.Program, cfg: { usdcMint: PublicKey; targetMint: PublicKey }) {
    this.program = program;
    this.config = PublicKey.findProgramAddressSync([CONFIG_SEED], program.programId)[0];
    this.usdcMint = cfg.usdcMint;
    this.targetMint = cfg.targetMint;
  }

  /** Per-user transient signing PDA (authority of the transient USDC account). */
  buyAuthority(user: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync([BUY_AUTH_SEED, user.toBuffer()], this.program.programId)[0];
  }

  /** The transient USDC account the pull deposits into and the swap drains. */
  transientUsdc(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.usdcMint, this.buyAuthority(user), true);
  }

  /** The user's own target-asset account (the only allowed destination). */
  destAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.targetMint, user);
  }

  /** Idempotently create the transient ATA (payer = keeper). Safe to include every run. */
  ensureTransientIx(user: PublicKey, payer: PublicKey): TransactionInstruction {
    return createAssociatedTokenAccountIdempotentInstruction(
      payer,
      this.transientUsdc(user),
      this.buyAuthority(user),
      this.usdcMint
    );
  }

  /** The router's execute_buy: forwards `swap` under the transient PDA signature and verifies the outcome. */
  async buildExecuteBuy(args: {
    user: PublicKey;
    keeper: PublicKey;
    minOut: anchor.BN;
    swap: SwapLeg;
  }): Promise<TransactionInstruction> {
    return this.program.methods
      .executeBuy(args.minOut, args.swap.data)
      .accounts({
        keeper: args.keeper,
        config: this.config,
        user: args.user,
        buyAuthority: this.buyAuthority(args.user),
        transientUsdc: this.transientUsdc(args.user),
        destAta: this.destAta(args.user),
        swapProgram: args.swap.program,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(args.swap.keys)
      .instruction();
  }

  /**
   * DEVNET/MAINNET pull leg: the native `transfer_recurring`. Build this with the
   * audited `@solana/subscriptions` client (the proven path; hand-rolling the
   * account resolution hits the known 0x83 async-builder gotcha). The receiver
   * ATA MUST be `transientUsdc(user)` so the pulled USDC lands where the router
   * expects it. PDAs: SA = ["SubscriptionAuthority", user, mint];
   * delegation = ["delegation", SA, delegator, delegatee, nonce]. Disc = 10.
   * Left as an integration seam so this module carries no web3.js-v2/kit peer.
   */
  buildNativePull(_args: {
    user: PublicKey;
    delegatee: PublicKey;
    nonce: anchor.BN;
    amount: anchor.BN;
  }): TransactionInstruction {
    throw new Error(
      "buildNativePull: wire the audited @solana/subscriptions transfer_recurring " +
        "with receiver = transientUsdc(user). Devnet integration (see SPEC ss.11)."
    );
  }

  /**
   * DEVNET/MAINNET swap leg: a Jupiter route USDC -> target. `userAuthority` is
   * the transient PDA (it signs via the router's invoke_signed); destination is
   * the user's own target ATA. NOTE: CPI-ing Jupiter from the router under a PDA
   * signer + one-tx size is the open item in SPEC ss.11 — verify on devnet.
   */
  async buildJupiterSwap(args: {
    user: PublicKey;
    amountIn: anchor.BN;
    slippageBps: number;
    apiBase?: string;
  }): Promise<SwapLeg> {
    const api = args.apiBase ?? "https://quote-api.jup.ag/v6";
    const authority = this.buyAuthority(args.user);
    const q = await fetch(
      `${api}/quote?inputMint=${this.usdcMint.toBase58()}&outputMint=${this.targetMint.toBase58()}` +
        `&amount=${args.amountIn.toString()}&slippageBps=${args.slippageBps}&onlyDirectRoutes=true`
    );
    const quote = await q.json();
    const r = await fetch(`${api}/swap-instructions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: authority.toBase58(),
        wrapAndUnwrapSol: false,
        destinationTokenAccount: this.destAta(args.user).toBase58(),
      }),
    });
    const j = await r.json();
    const si = j.swapInstruction;
    if (!si) throw new Error("Jupiter returned no swapInstruction: " + JSON.stringify(j).slice(0, 200));
    const keys: AccountMeta[] = si.accounts.map((a: any) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    }));
    return {
      program: new PublicKey(si.programId),
      data: Buffer.from(si.data, "base64"),
      keys,
      luts: [], // resolve j.addressLookupTableAddresses before sending on-chain
    };
  }

  /** Assemble + send the composed transaction as a v0 tx (supports LUTs). */
  async composeAndSend(args: {
    connection: Connection;
    payer: Keypair;
    ixs: TransactionInstruction[];
    luts?: AddressLookupTableAccount[];
    extraSigners?: Keypair[];
  }): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await args.connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: args.payer.publicKey,
      recentBlockhash: blockhash,
      instructions: args.ixs,
    }).compileToV0Message(args.luts ?? []);
    const tx = new VersionedTransaction(msg);
    tx.sign([args.payer, ...(args.extraSigners ?? [])]);
    const sig = await args.connection.sendTransaction(tx, { skipPreflight: false });
    await args.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return sig;
  }
}
