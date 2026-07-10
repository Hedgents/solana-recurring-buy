// Init/refresh the devnet protocol fee: 50 bps to the deployer (the operated-
// instance demo; the open-source reference default is 0).
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";
const rbIdl = require("../target/idl/recurring_buy.json");

describe("devnet fee init", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const payer = (provider.wallet as anchor.Wallet).payer;
  const rb = new anchor.Program(rbIdl, provider);
  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], rb.programId)[0];
  const feeConfig = PublicKey.findProgramAddressSync([Buffer.from("fee")], rb.programId)[0];

  it("sets 50 bps to the deployer", async () => {
    const exists = await provider.connection.getAccountInfo(feeConfig);
    if (!exists) {
      await rb.methods.initFeeConfig(50, payer.publicKey)
        .accountsPartial({ admin: payer.publicKey, config, feeConfig }).rpc();
      console.log("initialized fee config: 50 bps ->", payer.publicKey.toBase58());
    } else {
      await rb.methods.setFee(50, payer.publicKey)
        .accountsPartial({ admin: payer.publicKey, config, feeConfig }).rpc();
      console.log("updated fee config: 50 bps");
    }
    const fc: any = await (rb.account as any).feeConfig.fetch(feeConfig);
    assert.equal(fc.feeBps, 50);
  });
});
