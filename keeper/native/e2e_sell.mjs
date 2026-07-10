/**
 * Devnet M2 e2e: REAL native Subscriptions pull ON THE TARGET MINT, composed
 * ATOMICALLY with the router's execute_sell, in ONE transaction.
 *
 *   tx = [ transfer_recurring (native, TARGET mint, receiver = transient PDA ATA) ,
 *          execute_sell (router: amortized cap + swap -> USDC to the user) ]
 *
 * This also settles SPEC_M2 open question 1: the native rail is mint-
 * parameterized, so a delegation on an arbitrary SPL mint (our mock target)
 * works exactly like USDC. Self-DCA-out for the devnet proof (owner ==
 * delegatee == keeper == deployer); user != keeper separation is proven by the
 * localnet invariant suite.
 *
 *   node keeper/native/e2e_sell.mjs   (run scripts/devnet_sell_setup.ts first)
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

const rpc = createSolanaRpc("https://api.devnet.solana.com");
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

const tokenBal = async (a) => BigInt((await rpc.getTokenAccountBalance(address(a)).send()).value.amount);

async function main() {
  const secret = Uint8Array.from(JSON.parse(readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8")));
  const keeper = await createKeyPairSignerFromBytes(secret); // owner == delegatee == keeper
  const owner = keeper;
  const TARGET = address(F.targetMint);

  // Amortized draw, mirroring the on-chain cap: pot / periods_left.
  const pot = await tokenBal(F.userTargetAta);
  const now = Math.floor(Date.now() / 1000);
  const periods = BigInt(Math.max(Math.floor((F.sellEndTs - now) / F.sellPeriodSecs), 1));
  const DRAW = pot / periods;
  const MIN_OUT = (DRAW * 99n) / 100n; // $1 ref, 1% slippage band
  console.log(`pot ${pot} target units, ${periods} periods left -> draw ${DRAW}, min_out ${MIN_OUT}`);

  // Native rail, TARGET mint this time (the mint-parameterized check).
  const [saPda] = await findSubscriptionAuthorityPda({ user: owner.address, tokenMint: TARGET });
  const saMaybe = await fetchMaybeSubscriptionAuthority(rpc, saPda);
  if (!saMaybe.exists) {
    await sendTx(owner, [getInitSubscriptionAuthorityInstruction({
      owner, subscriptionAuthority: saPda, tokenMint: TARGET, userAta: address(F.userTargetAta),
      systemProgram: SYS, tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })]);
    console.log("init_subscription_authority (TARGET mint) ok");
  }
  const sa = await fetchSubscriptionAuthority(rpc, saPda);

  const nonce = BigInt(now);
  const [delegationPda] = await findRecurringDelegationPda({
    subscriptionAuthority: saPda, delegator: owner.address, delegatee: keeper.address, nonce,
  });
  await sendTx(owner, [getCreateRecurringDelegationInstruction({
    delegator: owner, subscriptionAuthority: saPda, delegationAccount: delegationPda,
    delegatee: keeper.address, systemProgram: SYS,
    recurringDelegation: {
      nonce, amountPerPeriod: DRAW, periodLengthS: BigInt(F.sellPeriodSecs),
      startTs: BigInt(now - 1), expiryTs: BigInt(now + 3650 * 86400),
      expectedSubscriptionAuthorityInitId: sa.data.initId,
    },
  })]);
  console.log("create_recurring_delegation (TARGET mint) ok");

  // --- the atomic sell ---
  const [eventAuthority] = await findEventAuthorityPda();
  const pullIx = getTransferRecurringInstruction({
    delegationPda, subscriptionAuthority: saPda, delegatorAta: address(F.userTargetAta),
    receiverAta: address(F.transientTarget), tokenMint: TARGET, tokenProgram: TOKEN_PROGRAM_ADDRESS,
    delegatee: keeper.address, eventAuthority, selfProgram: SUBSCRIPTIONS_PROGRAM_ADDRESS,
    transferData: { amount: DRAW, delegator: owner.address, mint: TARGET },
  });

  // Mock venue reversed: pool receives target, pays USDC to the user's USDC ATA.
  const swapData = cat(disc(msIdl, "swap"), u64(DRAW), u64(DRAW)); // $1: out == in
  const swapAccts = [
    acc(F.transientTarget, AccountRole.WRITABLE),  // source (target)
    acc(F.buyAuthority, AccountRole.READONLY),     // source_authority (router forces signer)
    acc(F.poolTarget, AccountRole.WRITABLE),       // pool receives target
    acc(F.poolUsdc, AccountRole.WRITABLE),         // pool pays USDC
    acc(F.destUsdcAta, AccountRole.WRITABLE),      // user's USDC ATA
    acc(F.poolAuthority, AccountRole.READONLY),
    acc(TOKEN_PROGRAM_ADDRESS, AccountRole.READONLY),
  ];

  // execute_sell(min_out, swap_data)
  const execData = cat(disc(rbIdl, "execute_sell"), u64(MIN_OUT), u32(swapData.length), swapData);
  const execIx = {
    programAddress: address(F.recurringBuy),
    accounts: [
      acc(keeper.address, AccountRole.WRITABLE_SIGNER), // keeper
      acc(F.config, AccountRole.READONLY),
      acc(owner.address, AccountRole.READONLY),         // user
      acc(F.sellPlan, AccountRole.WRITABLE),
      acc(F.buyAuthority, AccountRole.READONLY),
      acc(F.transientTarget, AccountRole.WRITABLE),
      acc(F.userTargetAta, AccountRole.READONLY),       // the pot (amortization cap)
      acc(F.destUsdcAta, AccountRole.WRITABLE),
      acc(F.mockSwap, AccountRole.READONLY),
      acc(TOKEN_PROGRAM_ADDRESS, AccountRole.READONLY),
      ...swapAccts,
    ],
    data: execData,
  };

  const usdcBefore = await tokenBal(F.destUsdcAta);
  const sig = await sendTx(keeper, [pullIx, execIx]);
  const usdcAfter = await tokenBal(F.destUsdcAta);
  const trans = await tokenBal(F.transientTarget);
  const potAfter = await tokenBal(F.userTargetAta);

  console.log("\n=== ATOMIC PULL(TARGET)+SELL+DELIVER ok ===");
  console.log("tx:", sig);
  console.log(`pot: ${pot} -> ${potAfter} target units (drew ${pot - potAfter})`);
  console.log(`user USDC: ${usdcBefore} -> ${usdcAfter} (delta ${usdcAfter - usdcBefore})`);
  console.log(`transient target after: ${trans} (must be 0)`);
  if (usdcAfter - usdcBefore < MIN_OUT) throw new Error("proceeds below min_out");
  if (trans !== 0n) throw new Error("transient not drained");
  if (pot - potAfter !== DRAW) throw new Error("draw != amortized amount");
  console.log("PASS");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
