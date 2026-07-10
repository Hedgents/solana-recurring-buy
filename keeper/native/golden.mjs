/**
 * Golden-vector dump for the three native Subscriptions instructions.
 * Builds each ix via the audited kit client with FIXED inputs (devnet fixture
 * addresses) and prints { accounts: [address, role], data: hex } so a
 * web3.js-v1 encoder (the browser authorization flow) can be verified
 * byte-for-byte against the kit encoding.
 *
 *   node keeper/native/golden.mjs
 */
import { address, createNoopSigner } from "@solana/kit";
import {
  getInitSubscriptionAuthorityInstruction, getCreateRecurringDelegationInstruction,
  getTransferRecurringInstruction, findSubscriptionAuthorityPda, findRecurringDelegationPda,
  findEventAuthorityPda, SUBSCRIPTIONS_PROGRAM_ADDRESS,
} from "@solana/subscriptions";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token";
import { readFileSync } from "fs";

const F = JSON.parse(readFileSync(new URL("../../scripts/.devnet.json", import.meta.url), "utf8"));
const SYS = address("11111111111111111111111111111111");
const ROLE = ["R", "W", "RS", "WS"];
const hex = (u8) => Buffer.from(u8).toString("hex");
const dump = (label, ix) => {
  console.log(`\n=== ${label} ===`);
  console.log("program:", ix.programAddress);
  ix.accounts.forEach((a, i) => console.log(`  [${i}] ${a.address}  ${ROLE[a.role]}`));
  console.log(`data (${ix.data.length}B):`, hex(ix.data));
};

// Fixed, reproducible inputs from the fixtures.
const OWNER = address(F.deployer);
const DELEGATEE = address(F.deployer);
const MINT = address(F.usdcMint);
const NONCE = 1_752_000_000n;
const CAP = 25_000_000n;
const PERIOD = 3600n;
const START = 1_752_000_000n;
const EXPIRY = 2_067_360_000n;
const INIT_ID = 7n;
const PULL = 10_000_000n;

const owner = createNoopSigner(OWNER);
const [userAta] = await findAssociatedTokenPda({ owner: OWNER, mint: MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
const [saPda] = await findSubscriptionAuthorityPda({ user: OWNER, tokenMint: MINT });
const [delegationPda] = await findRecurringDelegationPda({
  subscriptionAuthority: saPda, delegator: OWNER, delegatee: DELEGATEE, nonce: NONCE,
});
const [eventAuthority] = await findEventAuthorityPda();

console.log("fixed inputs:", JSON.stringify({
  owner: OWNER, mint: MINT, userAta, saPda, delegationPda, eventAuthority,
  nonce: NONCE.toString(), cap: CAP.toString(), period: PERIOD.toString(),
  start: START.toString(), expiry: EXPIRY.toString(), initId: INIT_ID.toString(),
  pull: PULL.toString(),
}, null, 2));

dump("init_subscription_authority", getInitSubscriptionAuthorityInstruction({
  owner, subscriptionAuthority: saPda, tokenMint: MINT, userAta,
  systemProgram: SYS, tokenProgram: TOKEN_PROGRAM_ADDRESS,
}));

dump("create_recurring_delegation", getCreateRecurringDelegationInstruction({
  delegator: owner, subscriptionAuthority: saPda, delegationAccount: delegationPda,
  delegatee: DELEGATEE, systemProgram: SYS,
  recurringDelegation: {
    nonce: NONCE, amountPerPeriod: CAP, periodLengthS: PERIOD,
    startTs: START, expiryTs: EXPIRY, expectedSubscriptionAuthorityInitId: INIT_ID,
  },
}));

dump("transfer_recurring", getTransferRecurringInstruction({
  delegationPda, subscriptionAuthority: saPda, delegatorAta: userAta,
  receiverAta: userAta, tokenMint: MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS,
  delegatee: createNoopSigner(DELEGATEE), eventAuthority,
  selfProgram: SUBSCRIPTIONS_PROGRAM_ADDRESS,
  transferData: { amount: PULL, delegator: OWNER, mint: MINT },
}));
