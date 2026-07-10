/**
 * Keeper daemon: scans the native Subscriptions rail for recurring delegations
 * naming THIS keeper as delegatee, and cranks due work each tick:
 *
 *   USDC-mint delegation                       -> atomic [pull, swap, execute_buy]
 *   TARGET-mint delegation + due SellPlan      -> atomic [pull, swap, execute_sell]
 *
 * The keeper is a TRIGGER, not a custodian: every account it can touch is
 * bounded on-chain (delegation caps, amortization cap, canonical ATAs,
 * mandatory price floor). A malicious or buggy daemon can waste its own fees,
 * never a user's funds.
 *
 *   node keeper/native/daemon.mjs --once     one tick, then exit
 *   node keeper/native/daemon.mjs            loop (INTERVAL_S, default 60)
 *
 * Devnet reference: mock venue at the config reference price. Mainnet swaps
 * this leg for a live route (SPEC §11.2).
 */
import {
  createSolanaRpc, createSolanaRpcSubscriptions, createKeyPairSignerFromBytes,
  address, pipe, createTransactionMessage, appendTransactionMessageInstructions,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners, sendAndConfirmTransactionFactory,
  getSignatureFromTransaction, AccountRole,
} from "@solana/kit";
import {
  getTransferRecurringInstruction, findSubscriptionAuthorityPda, findEventAuthorityPda,
  fetchDelegationsByDelegatee, SUBSCRIPTIONS_PROGRAM_ADDRESS,
} from "@solana/subscriptions";
import {
  TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction,
} from "@solana-program/token";
import { readFileSync } from "fs";
import os from "os";

const F = JSON.parse(readFileSync(new URL("../../scripts/.devnet.json", import.meta.url), "utf8"));
const rbIdl = JSON.parse(readFileSync(new URL("../../target/idl/recurring_buy.json", import.meta.url), "utf8"));
const msIdl = JSON.parse(readFileSync(new URL("../../target/idl/mock_swap.json", import.meta.url), "utf8"));

const RB = address(F.recurringBuy);
const MS = address(F.mockSwap);
const USDC = F.usdcMint;
const TARGET = F.targetMint;
const SLIPPAGE_BPS = BigInt(F.maxSlippageBps ?? 100);
const INTERVAL_S = Number(process.env.INTERVAL_S ?? 60);

const rpc = createSolanaRpc(process.env.RPC ?? "https://api.devnet.solana.com");
const rpcSubscriptions = createSolanaRpcSubscriptions(process.env.WS ?? "wss://api.devnet.solana.com");
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

const u64 = (v) => { const b = new Uint8Array(8); let x = BigInt(v); for (let i = 0; i < 8; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
const u32 = (v) => { const b = new Uint8Array(4); let x = v >>> 0; for (let i = 0; i < 4; i++) { b[i] = x & 0xff; x >>= 8; } return b; };
const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
const disc = (idl, name) => Uint8Array.from(idl.instructions.find((i) => i.name === name).discriminator);
const acc = (a, role) => ({ address: address(a), role });
const log = (...a) => console.log(new Date().toISOString(), ...a);

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

const chainNow = async () => {
  const slot = await rpc.getSlot({ commitment: "confirmed" }).send();
  return Number(await rpc.getBlockTime(slot).send());
};
const bal = async (ata) => {
  try { return BigInt((await rpc.getTokenAccountBalance(address(ata)).send()).value.amount); }
  catch { return 0n; }
};
const ata = async (owner, mint) =>
  (await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

// SellPlan PDA + raw decode (8 disc | user 32 | end i64 | period i64 | next_due i64 | bump).
import { getProgramDerivedAddress, getUtf8Encoder, getAddressEncoder, getBase64Encoder } from "@solana/kit";
const sellPlanPda = async (user) =>
  (await getProgramDerivedAddress({
    programAddress: RB,
    seeds: [getUtf8Encoder().encode("sell-plan"), getAddressEncoder().encode(address(user))],
  }))[0];
const buyAuthPda = async (user) =>
  (await getProgramDerivedAddress({
    programAddress: RB,
    seeds: [getUtf8Encoder().encode("buy"), getAddressEncoder().encode(address(user))],
  }))[0];

async function fetchSellPlan(user) {
  const pda = await sellPlanPda(user);
  const info = await rpc.getAccountInfo(pda, { encoding: "base64" }).send();
  if (!info.value) return null;
  const d = Buffer.from(info.value.data[0], "base64");
  return {
    pda,
    endTs: Number(d.readBigInt64LE(40)),
    periodSecs: Number(d.readBigInt64LE(48)),
    nextDueTs: Number(d.readBigInt64LE(56)),
  };
}

/** Pullable amount for a delegation right now (lazy period roll). */
function available(del, now) {
  const d = del.data;
  if (BigInt(now) >= BigInt(d.currentPeriodStartTs) + BigInt(d.periodLengthS)) return BigInt(d.amountPerPeriod);
  const left = BigInt(d.amountPerPeriod) - BigInt(d.amountPulledInPeriod);
  return left > 0n ? left : 0n;
}

function pullIx(del, delegatee, delegatorAta, receiverAta, amount, saPda, eventAuthority, mint) {
  return getTransferRecurringInstruction({
    delegationPda: del.address, subscriptionAuthority: saPda,
    delegatorAta: address(delegatorAta), receiverAta: address(receiverAta),
    tokenMint: address(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS,
    delegatee, eventAuthority, selfProgram: SUBSCRIPTIONS_PROGRAM_ADDRESS,
    transferData: { amount, delegator: del.data.header.delegator, mint: address(mint) },
  });
}

// Mock venue: transfer(source -> poolIn), then pay (poolOut -> dest) 1:1.
function mockSwapIx(source, sourceAuth, poolIn, poolOut, dest, amountIn, out) {
  return {
    programAddress: MS,
    accounts: [
      acc(source, AccountRole.WRITABLE), acc(sourceAuth, AccountRole.READONLY),
      acc(poolIn, AccountRole.WRITABLE), acc(poolOut, AccountRole.WRITABLE),
      acc(dest, AccountRole.WRITABLE), acc(F.poolAuthority, AccountRole.READONLY),
      acc(TOKEN_PROGRAM_ADDRESS, AccountRole.READONLY),
    ],
    data: cat(disc(msIdl, "swap"), u64(amountIn), u64(out)),
  };
}

const floorOut = (amountIn) => (amountIn * (10_000n - SLIPPAGE_BPS)) / 10_000n; // $1 ref, 6dp both sides

async function crankBuy(keeper, del, now, eventAuthority) {
  const user = del.data.header.delegator;
  const avail = available(del, now);
  if (avail <= 0n) return log(`buy  ${user.slice(0, 6)}: nothing available this period`);

  const buyAuth = await buyAuthPda(user);
  const transient = await ata(buyAuth, USDC);
  const userUsdc = await ata(user, USDC);
  const dest = await ata(user, TARGET);
  const [saPda] = await findSubscriptionAuthorityPda({ user: address(user), tokenMint: address(USDC) });

  const residue = await bal(transient);
  const amountIn = avail + residue;
  const minOut = floorOut(amountIn);

  const ixs = [
    getCreateAssociatedTokenIdempotentInstruction({ payer: keeper, ata: transient, owner: buyAuth, mint: address(USDC), tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: keeper, ata: dest, owner: address(user), mint: address(TARGET), tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    pullIx(del, keeper, userUsdc, transient, avail, saPda, eventAuthority, USDC),
  ];
  const swap = mockSwapIx(transient, buyAuth, F.poolUsdc, F.poolTarget, dest, amountIn, amountIn);
  const execData = cat(disc(rbIdl, "execute_buy"), u64(minOut), u32(swap.data.length), swap.data);
  ixs.push({
    programAddress: RB,
    accounts: [
      acc(keeper.address, AccountRole.WRITABLE_SIGNER), acc(F.config, AccountRole.READONLY),
      acc(user, AccountRole.READONLY), acc(buyAuth, AccountRole.READONLY),
      acc(transient, AccountRole.WRITABLE), acc(dest, AccountRole.WRITABLE),
      acc(MS, AccountRole.READONLY), acc(TOKEN_PROGRAM_ADDRESS, AccountRole.READONLY),
      ...swap.accounts,
    ],
    data: execData,
  });
  const sig = await sendTx(keeper, ixs);
  log(`buy  ${user.slice(0, 6)}: pulled ${avail} uUSDC -> bought (tx ${sig.slice(0, 16)}…)`);
}

async function crankSell(keeper, del, now, eventAuthority) {
  const user = del.data.header.delegator;
  const plan = await fetchSellPlan(user);
  if (!plan) return log(`sell ${user.slice(0, 6)}: delegation but no SellPlan — skip`);
  if (plan.nextDueTs > plan.endTs) return log(`sell ${user.slice(0, 6)}: schedule complete`);
  if (now < plan.nextDueTs) return log(`sell ${user.slice(0, 6)}: due in ${plan.nextDueTs - now}s`);

  const buyAuth = await buyAuthPda(user);
  const transient = await ata(buyAuth, TARGET);
  const userTarget = await ata(user, TARGET);
  const destUsdc = await ata(user, USDC);
  const [saPda] = await findSubscriptionAuthorityPda({ user: address(user), tokenMint: address(TARGET) });

  const pot = await bal(userTarget);
  const residue = await bal(transient);
  const periods = BigInt(Math.max(Math.floor((plan.endTs - now) / plan.periodSecs), 1));
  const cap = (pot + residue) / periods;
  let pull = cap > residue ? cap - residue : 0n;
  const avail = available(del, now);
  if (pull > avail) pull = avail;
  if (pull <= 0n && residue <= 0n) return log(`sell ${user.slice(0, 6)}: nothing to draw (pot ${pot}, avail ${avail})`);

  const amountIn = pull + residue;
  const minOut = floorOut(amountIn);
  const ixs = [
    getCreateAssociatedTokenIdempotentInstruction({ payer: keeper, ata: transient, owner: buyAuth, mint: address(TARGET), tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: keeper, ata: destUsdc, owner: address(user), mint: address(USDC), tokenProgram: TOKEN_PROGRAM_ADDRESS }),
  ];
  if (pull > 0n) ixs.push(pullIx(del, keeper, userTarget, transient, pull, saPda, eventAuthority, TARGET));
  const swap = mockSwapIx(transient, buyAuth, F.poolTarget, F.poolUsdc, destUsdc, amountIn, amountIn);
  const execData = cat(disc(rbIdl, "execute_sell"), u64(minOut), u32(swap.data.length), swap.data);
  ixs.push({
    programAddress: RB,
    accounts: [
      acc(keeper.address, AccountRole.WRITABLE_SIGNER), acc(F.config, AccountRole.READONLY),
      acc(user, AccountRole.READONLY), acc(plan.pda, AccountRole.WRITABLE),
      acc(buyAuth, AccountRole.READONLY), acc(transient, AccountRole.WRITABLE),
      acc(userTarget, AccountRole.READONLY), acc(destUsdc, AccountRole.WRITABLE),
      acc(MS, AccountRole.READONLY), acc(TOKEN_PROGRAM_ADDRESS, AccountRole.READONLY),
      ...swap.accounts,
    ],
    data: execData,
  });
  const sig = await sendTx(keeper, ixs);
  log(`sell ${user.slice(0, 6)}: drew ${pull} target -> USDC (tx ${sig.slice(0, 16)}…)`);
}

async function tick(keeper, eventAuthority) {
  const now = await chainNow();
  const dels = await fetchDelegationsByDelegatee(rpc, keeper.address);
  // Latest-expiry delegation per (delegator, mint); ignore foreign mints.
  const best = new Map();
  for (const d of dels) {
    const mint = d.data.mint.toString();
    if (mint !== USDC && mint !== TARGET) continue;
    const key = `${d.data.header.delegator}|${mint}`;
    const cur = best.get(key);
    if (!cur || BigInt(d.data.expiryTs) > BigInt(cur.data.expiryTs)) best.set(key, d);
  }
  log(`tick: ${dels.length} delegations, ${best.size} relevant`);
  for (const d of best.values()) {
    const isBuy = d.data.mint.toString() === USDC;
    try {
      if (isBuy) await crankBuy(keeper, d, now, eventAuthority);
      else await crankSell(keeper, d, now, eventAuthority);
    } catch (e) {
      log(`${isBuy ? "buy " : "sell"} ${d.data.header.delegator.slice(0, 6)}: ERROR ${String(e.message ?? e).slice(0, 180)}`);
    }
  }
}

async function main() {
  const secret = Uint8Array.from(JSON.parse(readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8")));
  const keeper = await createKeyPairSignerFromBytes(secret);
  const [eventAuthority] = await findEventAuthorityPda();
  log(`keeper ${keeper.address} | rb ${RB} | usdc ${USDC} | target ${TARGET}`);

  if (process.argv.includes("--once")) {
    await tick(keeper, eventAuthority);
    return;
  }
  // Loop forever; a failed tick never kills the daemon.
  for (;;) {
    try { await tick(keeper, eventAuthority); } catch (e) { log("tick ERROR", String(e.message ?? e).slice(0, 200)); }
    await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
