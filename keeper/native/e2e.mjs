/**
 * Devnet e2e: REAL native Subscriptions pull, composed ATOMICALLY with the
 * router's execute_buy, in ONE transaction.
 *
 *   tx = [ transfer_recurring (native, receiver = transient PDA ATA) ,
 *          execute_buy (router: swap via mock venue -> deliver to user) ]
 *
 * Self-DCA for the devnet proof: owner == delegatee == keeper == deployer
 * (the user != keeper separation is proven by the localnet invariant suite).
 * Instructions for our two Anchor programs are hand-encoded in the kit stack so
 * the whole thing shares one signing flow (avoids the v1<->v2 peer conflict).
 *
 *   node keeper/native/e2e.mjs
 */
import {
  createSolanaRpc, createSolanaRpcSubscriptions, createKeyPairSignerFromBytes,
  address, pipe, createTransactionMessage, appendTransactionMessageInstructions,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners, sendAndConfirmTransactionFactory,
  getSignatureFromTransaction, AccountRole,
} from "@solana/kit";
import {
  getInitSubscriptionAuthorityInstruction, getCreateRecurringDelegationInstruction,
  getTransferRecurringInstruction, findSubscriptionAuthorityPda, findRecurringDelegationPda,
  findEventAuthorityPda, fetchMaybeSubscriptionAuthority, fetchSubscriptionAuthority,
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
} from "@solana/subscriptions";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { readFileSync } from "fs";
import os from "os";

const F = JSON.parse(readFileSync(new URL("../../scripts/.devnet.json", import.meta.url), "utf8"));
const rbIdl = JSON.parse(readFileSync(new URL("../../target/idl/recurring_buy.json", import.meta.url), "utf8"));
const msIdl = JSON.parse(readFileSync(new URL("../../target/idl/mock_swap.json", import.meta.url), "utf8"));
const SYS = address("11111111111111111111111111111111");

const PULL = 10_000_000n; // 10 USDC this period
const CAP = 25_000_000n;  // per-period cap

const rpc = createSolanaRpc("https://api.devnet.solana.com");
const RB_FEE = async () => {
  const { getProgramDerivedAddress, getUtf8Encoder } = await import("@solana/kit");
  const [pda] = await getProgramDerivedAddress({ programAddress: address(F.recurringBuy), seeds: [getUtf8Encoder().encode("fee")] });
  const info = await rpc.getAccountInfo(pda, { encoding: "base64" }).send();
  if (!info.value) return { pda, bps: 0n, destination: null };
  const d = Buffer.from(info.value.data[0], "base64");
  const { getBase58Decoder } = await import("@solana/kit");
  return { pda, bps: BigInt(d.readUInt16LE(8)), destination: getBase58Decoder().decode(d.subarray(10, 42)) };
};
const rpcSubscriptions = createSolanaRpcSubscriptions("wss://api.devnet.solana.com");
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

const u64 = (v) => { const b = new Uint8Array(8); let x = BigInt(v); for (let i = 0; i < 8; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
const u32 = (v) => { const b = new Uint8Array(4); let x = v >>> 0; for (let i = 0; i < 4; i++) { b[i] = x & 0xff; x >>= 8; } return b; };
const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
const disc = (idl, name) => Uint8Array.from(idl.instructions.find((i) => i.name === name).discriminator);
const acc = (addr, role) => ({ address: address(addr), role });

async function sendTx(feePayer, ixs) {
  const { value: bh } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(ixs, m)
  );
  const signed = await signTransactionMessageWithSigners(msg);
  await sendAndConfirm(signed, { commitment: "confirmed" });
  return getSignatureFromTransaction(signed);
}

async function main() {
  const secret = Uint8Array.from(JSON.parse(readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8")));
  const keeper = await createKeyPairSignerFromBytes(secret); // owner == delegatee == keeper
  const owner = keeper;
  const USDC = address(F.usdcMint);

  const [saPda] = await findSubscriptionAuthorityPda({ user: owner.address, tokenMint: USDC });
  const saMaybe = await fetchMaybeSubscriptionAuthority(rpc, saPda);
  if (!saMaybe.exists) {
    await sendTx(owner, [getInitSubscriptionAuthorityInstruction({
      owner, subscriptionAuthority: saPda, tokenMint: USDC, userAta: address(F.deployerUsdc),
      systemProgram: SYS, tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })]);
    console.log("init_subscription_authority ok");
  }
  const sa = await fetchSubscriptionAuthority(rpc, saPda);

  // Fresh recurring delegation each run (new nonce => a fresh, immediately-due period).
  const nonce = BigInt(Math.floor(Date.now() / 1000));
  const now = nonce;
  const [delegationPda] = await findRecurringDelegationPda({
    subscriptionAuthority: saPda, delegator: owner.address, delegatee: keeper.address, nonce,
  });
  await sendTx(owner, [getCreateRecurringDelegationInstruction({
    delegator: owner, subscriptionAuthority: saPda, delegationAccount: delegationPda,
    delegatee: keeper.address, systemProgram: SYS,
    recurringDelegation: {
      nonce, amountPerPeriod: CAP, periodLengthS: 3600n,
      startTs: now - 1n, expiryTs: now + 3650n * 86400n,
      expectedSubscriptionAuthorityInitId: sa.data.initId,
    },
  })]);
  console.log("create_recurring_delegation ok");

  // --- the atomic buy ---
  const [eventAuthority] = await findEventAuthorityPda();
  const pullIx = getTransferRecurringInstruction({
    delegationPda, subscriptionAuthority: saPda, delegatorAta: address(F.deployerUsdc),
    receiverAta: address(F.transient), tokenMint: USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS,
    delegatee: keeper.address, eventAuthority, selfProgram: SUBSCRIPTIONS_PROGRAM_ADDRESS,
    transferData: { amount: PULL, delegator: owner.address, mint: USDC },
  });

  // Protocol fee: net-size the venue leg and pass the fee accounts.
  const feeCfg = await RB_FEE();
  const FEE = (PULL * feeCfg.bps) / 10_000n;
  const NET = PULL - FEE;
  const MIN_OUT = (NET * 99n) / 100n;
  const { getProgramDerivedAddress: _g, getUtf8Encoder: _u } = await import("@solana/kit");
  const { findAssociatedTokenPda } = await import("@solana-program/token");
  const [feeAta] = await findAssociatedTokenPda({ owner: address(feeCfg.destination ?? keeper.address), mint: USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS });

  // mock_swap.swap(amount_in, out_amount) -> its data + accounts become the router's swap leg.
  const swapData = cat(disc(msIdl, "swap"), u64(NET), u64(NET));
  const swapAccts = [
    acc(F.transient, AccountRole.WRITABLE),        // source_usdc
    acc(F.buyAuthority, AccountRole.READONLY),     // source_authority (router forces signer in CPI)
    acc(F.poolUsdc, AccountRole.WRITABLE),
    acc(F.poolTarget, AccountRole.WRITABLE),
    acc(F.dest, AccountRole.WRITABLE),             // dest_target
    acc(F.poolAuthority, AccountRole.READONLY),
    acc(TOKEN_PROGRAM_ADDRESS, AccountRole.READONLY),
  ];

  // execute_buy(min_out, swap_data)
  const execData = cat(disc(rbIdl, "execute_buy"), u64(MIN_OUT), u32(swapData.length), swapData);
  const execIx = {
    programAddress: address(F.recurringBuy),
    accounts: [
      acc(keeper.address, AccountRole.WRITABLE_SIGNER), // keeper
      acc(F.config, AccountRole.READONLY),
      acc(owner.address, AccountRole.READONLY),         // user (== owner in self-DCA)
      acc(F.buyAuthority, AccountRole.READONLY),
      acc(F.transient, AccountRole.WRITABLE),
      acc(F.dest, AccountRole.WRITABLE),
      acc(F.mockSwap, AccountRole.READONLY),            // swap_program
      acc(TOKEN_PROGRAM_ADDRESS, AccountRole.READONLY),
      acc(feeCfg.pda, AccountRole.READONLY),
      acc(feeAta, AccountRole.WRITABLE),
      ...swapAccts,                                     // remaining_accounts
    ],
    data: execData,
  };

  const before = (await rpc.getTokenAccountBalance(address(F.dest)).send()).value.amount;
  const sig = await sendTx(keeper, [pullIx, execIx]);
  const after = (await rpc.getTokenAccountBalance(address(F.dest)).send()).value.amount;
  const trans = (await rpc.getTokenAccountBalance(address(F.transient)).send()).value.amount;

  console.log("\n=== ATOMIC PULL+SWAP+DELIVER ok ===");
  console.log("tx:", sig);
  console.log(`dest target: ${before} -> ${after} (delta ${Number(after) - Number(before)})`);
  console.log(`transient USDC after: ${trans} (must be 0)`);
  if (Number(after) - Number(before) < Number(MIN_OUT)) throw new Error("delivery below min_out");
  if (Number(trans) !== 0) throw new Error("transient not drained");
  console.log("PASS");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
