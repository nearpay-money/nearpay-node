/**
 * Refund signing helpers: NEP-413 / ERC-191 / raw-ed25519 against `@nearpay/spec/test-vectors`,
 * the next_action checks (never a different recipient or amount), and `signAndSubmit` end to end
 * against the spec-validating mock.
 */

import { getRefund, MultiPayload, submitRefundTx } from "@nearpay/spec";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type ChainTransfer,
  checkRefundAction,
  type EvmMessageAccountLike,
  type EvmWalletLike,
  evmAccountSigner,
  evmTransferRequest,
  evmWalletSender,
  NearPay,
  NearPayRefundSigningError,
  nearKeyPairSigner,
  type RefundSignIntentAction,
  signRefundIntent,
} from "../../src/index.js";
import {
  base58Decode,
  base58Encode,
  erc20TransferData,
  nep413Hash,
  normalizeErc191Signature,
} from "../../src/signing/encoding.js";
import { chainTransferOf } from "../../src/signing/refunds.js";
import {
  ed25519FromSeed,
  ids,
  intentsVectors,
  now,
  PAYER,
  refund,
  signAndSendAction,
  signIntentAction,
  USDC_BASE_TOKEN,
} from "../support/fixtures.js";
import { MockApiError, type SpecMock, startSpecMock } from "../support/spec-mock.js";

const v = intentsVectors;
const nearKey = ed25519FromSeed(v.nep413.seed_hex);
const rawKey = ed25519FromSeed(v.raw_ed25519.seed_hex);

/** A viem-like local account over the vector's private key: personal_sign → 0x r‖s‖v (v = 27/28). */
function evmAccount(privateKeyHex: string, address: string): EvmMessageAccountLike {
  const sk = Buffer.from(privateKeyHex, "hex");
  return {
    address,
    async signMessage({ message }) {
      const bytes = Buffer.from(message, "utf8");
      const prefixed = Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${bytes.length}`), bytes]);
      const rec = secp256k1.sign(keccak_256(prefixed), sk, { prehash: false, format: "recovered" });
      const out = Buffer.concat([Buffer.from(rec.subarray(1, 65)), Buffer.from([27 + (rec[0] as number)])]);
      return `0x${out.toString("hex")}`;
    },
  };
}
const err = (code: string) => expect.objectContaining({ code, name: "NearPayRefundSigningError" });

describe("encodings and vectors", () => {
  it("base58 round-trips (leading zeros) and rejects foreign characters", () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 255]);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    expect(base58Encode(new Uint8Array())).toBe("");
    expect(() => base58Decode("0OIl")).toThrow(/base58/);
  });

  it("computes the NEP-413 hash of the spec vector", () => {
    const p = v.nep413.multipayload.payload as { message: string; nonce: string; recipient: string };
    const hash = nep413Hash({ message: p.message, nonce: Buffer.from(p.nonce, "base64"), recipient: p.recipient });
    expect(hash.toString("hex")).toBe(v.nep413.hash_hex);
    const withCb = nep413Hash({ ...p, nonce: Buffer.from(p.nonce, "base64"), callbackUrl: "https://cb" });
    expect(withCb.toString("hex")).not.toBe(v.nep413.hash_hex);
    expect(() => nep413Hash({ ...p, nonce: new Uint8Array(31) })).toThrow(/32 bytes/);
  });

  it("the NEAR key-pair signer reproduces the nep413 and raw_ed25519 vector signatures", async () => {
    expect(nearKey.publicKeyHex).toBe(v.nep413.signer_id);
    const p = v.nep413.multipayload.payload as { message: string; nonce: string };
    const action = {
      ...signIntentAction({ signerId: v.nep413.signer_id }),
      nep413: { recipient: "intents.near" as const, nonce: p.nonce, message: p.message },
    };
    const signed = await nearKeyPairSigner(nearKey.keyPair).sign(action);
    expect(signed).toEqual(v.nep413.multipayload);

    const rawPayload = v.raw_ed25519.multipayload.payload as string;
    const rawAction = { ...signIntentAction({ signerId: v.raw_ed25519.signer_id }), payload: rawPayload };
    const rawSigned = await nearKeyPairSigner(rawKey.keyPair, { standard: "raw_ed25519" }).sign(rawAction);
    expect(rawSigned).toEqual(v.raw_ed25519.multipayload);
  });

  it("the EVM account signer reproduces the erc191 vector (v normalised to 0/1, low s)", async () => {
    const account = evmAccount(v.erc191.private_key_hex, v.erc191.address);
    const action = {
      ...signIntentAction({ signerId: v.erc191.address, standards: ["erc191"] }),
      payload: v.erc191.multipayload.payload as string,
    };
    expect(await evmAccountSigner(account).sign(action)).toEqual(v.erc191.multipayload);
  });

  it("normalises ERC-191 signatures: v 27/28 → 0/1, high s → n − s with v flipped; rejects malformed ones", () => {
    const r = "11".repeat(32);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = (n - 5n).toString(16).padStart(64, "0");
    const out = normalizeErc191Signature(`0x${r}${highS}1b`);
    expect(Buffer.from(out.subarray(32, 64)).toString("hex")).toBe("5".padStart(64, "0"));
    expect(out[64]).toBe(1);
    expect(normalizeErc191Signature(`${r}${"05".padStart(64, "0")}01`)[64]).toBe(1);
    expect(() => normalizeErc191Signature("0x1234")).toThrow(/65 bytes/);
    expect(() => normalizeErc191Signature(`0x${r}${"05".padStart(64, "0")}05`)).toThrow(/recovery id/);
    expect(() => normalizeErc191Signature(`0x${r}${"0".repeat(64)}00`)).toThrow(/s out of range/);
    expect(() => normalizeErc191Signature("0xzz")).toThrow(/hex/);
  });

  it("encodes ERC-20 transfer calldata", () => {
    expect(erc20TransferData("0x1111111111111111111111111111111111111111", 2_000_000n)).toBe(
      `0xa9059cbb${"1111111111111111111111111111111111111111".padStart(64, "0")}${"1e8480".padStart(64, "0")}`,
    );
    expect(() => erc20TransferData("0x12", 1n)).toThrow(/EVM address/);
    expect(() => erc20TransferData("0x1111111111111111111111111111111111111111", -1n)).toThrow(/uint256/);
  });
});

describe("checkRefundAction: nothing but the displayed transfer is ever signed", () => {
  const action = () => signIntentAction({ signerId: nearKey.publicKeyHex });

  it("accepts a consistent sign_intent and a consistent sign_and_send", () => {
    const ok = checkRefundAction(refund({ next_action: action() }));
    expect(ok.action.type).toBe("sign_intent");
    expect(ok.leg).toBe(1);
    expect(checkRefundAction(refund({ next_action: signAndSendAction() })).action.type).toBe("sign_and_send");
  });

  const tampered: [string, (a: ReturnType<typeof action>) => unknown, string][] = [
    [
      "payload with another receiver",
      (a) => ({ ...a, payload: a.payload.replace(PAYER, "thief.near") }),
      "payload_mismatch",
    ],
    [
      "NEP-413 message with another amount",
      (a) => ({ ...a, nep413: { ...a.nep413, message: a.nep413.message.replace("2000000", "2000001") } }),
      "payload_mismatch",
    ],
    [
      "NEP-413 nonce differs",
      (a) => ({ ...a, nep413: { ...a.nep413, nonce: `${"A".repeat(43)}=` } }),
      "payload_mismatch",
    ],
    [
      "message signer differs",
      (a) => {
        const message = { ...a.message, signer_id: "other.near" };
        return {
          ...a,
          message,
          payload: JSON.stringify(message),
          nep413: {
            ...a.nep413,
            message: JSON.stringify({ signer_id: "other.near", deadline: message.deadline, intents: message.intents }),
          },
        };
      },
      "payload_mismatch",
    ],
    [
      "two transfers",
      (a) => {
        const intents = [...a.message.intents, { ...a.message.intents[0], receiver_id: "thief.near" }];
        const message = { ...a.message, intents };
        return {
          ...a,
          message,
          payload: JSON.stringify(message),
          nep413: {
            ...a.nep413,
            message: JSON.stringify({ signer_id: message.signer_id, deadline: message.deadline, intents }),
          },
        };
      },
      "payload_mismatch",
    ],
    [
      "displayed receiver differs from the payload",
      (a) => ({ ...a, transfer: { ...a.transfer, receiver_id: "shown.near" } }),
      "payload_mismatch",
    ],
    [
      "displayed amount differs from the payload",
      (a) => ({ ...a, transfer: { ...a.transfer, amount: "1" } }),
      "payload_mismatch",
    ],
    [
      "memo differs",
      (a) => ({ ...a, transfer: { ...a.transfer, memo: "np1:AQDxa2L6a5d8egVC7YP85UgtUCYp3cUotS6S3EsGcF7i" } }),
      "payload_mismatch",
    ],
    ["deadline differs", (a) => ({ ...a, deadline: a.deadline + 100 }), "payload_mismatch"],
    ["payload is not JSON", (a) => ({ ...a, payload: "{not json" }), "payload_mismatch"],
  ];
  for (const [name, mutate, code] of tampered) {
    it(`refuses: ${name}`, () => {
      const r = refund({ next_action: action() });
      const bad = { ...r, next_action: mutate(action()) } as typeof r;
      expect(() => checkRefundAction(bad)).toThrow(err(code));
    });
  }

  it("refuses an intents_transfer refund whose receiver is not the payer's recorded account (INV-7)", () => {
    const r = refund({ next_action: signIntentAction({ signerId: nearKey.publicKeyHex, receiver: "thief.near" }) });
    expect(() => checkRefundAction(r)).toThrow(err("recipient_mismatch"));
  });

  it("refuses another asset, a leg amount mismatch, a submitted leg, a passed deadline, no action", () => {
    const r = refund({ next_action: action() });
    expect(() => checkRefundAction({ ...r, asset_id: "nep141:other.near" })).toThrow(err("payload_mismatch"));
    const legs = r.legs.map((l) => ({ ...l, amount: "1" }));
    expect(() => checkRefundAction({ ...r, legs })).toThrow(err("payload_mismatch"));
    const sent = r.legs.map((l) => ({ ...l, submitted_tx: "0xabcdef12" }));
    expect(() => checkRefundAction({ ...r, legs: sent })).toThrow(err("already_submitted"));
    expect(() =>
      checkRefundAction(refund({ next_action: signIntentAction({ signerId: "m.near", deadline: now() + 30 }) })),
    ).toThrow(err("deadline_passed"));
    expect(() => checkRefundAction(r, { now: r.next_action?.deadline })).toThrow(err("deadline_passed"));
    expect(checkRefundAction(r, { minSecondsLeft: 0, now: (r.next_action?.deadline ?? 0) - 1 }).leg).toBe(1);
    expect(() => checkRefundAction(refund())).toThrow(err("no_action"));
    expect(() => checkRefundAction({ ...r, next_action: { type: "sign_with_magic" } } as never)).toThrow(
      err("invalid_action"),
    );
    expect(() => checkRefundAction(null as never)).toThrow(err("invalid_action"));
    const sas = refund({ next_action: signAndSendAction() });
    expect(() => checkRefundAction({ ...sas, asset_id: "nep141:other.near" })).toThrow(err("payload_mismatch"));
    expect(() => checkRefundAction(refund({ next_action: signAndSendAction({ deadline: now() + 5 }) }))).toThrow(
      err("deadline_passed"),
    );
    expect(checkRefundAction({ ...r, legs: [] }).leg).toBeUndefined();
  });
});

describe("signers refuse the wrong key or account", () => {
  it("NEAR: a key that is not the implicit account's key; a lying key pair; unsupported standards", async () => {
    const a = signIntentAction({ signerId: nearKey.publicKeyHex });
    await expect(nearKeyPairSigner(rawKey.keyPair).sign(a)).rejects.toThrow(err("signer_mismatch"));
    const liar = { ...nearKey.keyPair, getPublicKey: rawKey.keyPair.getPublicKey };
    const named = signIntentAction({ signerId: "merchant.near" });
    await expect(nearKeyPairSigner(liar).sign(named)).rejects.toThrow(err("signer_mismatch"));
    const secp = { sign: nearKey.keyPair.sign, getPublicKey: () => ({ toString: () => "secp256k1:abc" }) };
    await expect(nearKeyPairSigner(secp).sign(named)).rejects.toThrow(err("signer_mismatch"));
    await expect(
      nearKeyPairSigner(nearKey.keyPair).sign({ ...a, standards: ["erc191"] } as RefundSignIntentAction),
    ).rejects.toThrow(err("signer_mismatch"));
    expect((await nearKeyPairSigner(nearKey.keyPair).sign(named)).standard).toBe("nep413");
  });

  it("EVM: another address, unsupported standard, a malformed signature", async () => {
    const account = evmAccount(v.erc191.private_key_hex, v.erc191.address);
    const a = signIntentAction({ signerId: "0x0000000000000000000000000000000000000001", standards: ["erc191"] });
    await expect(evmAccountSigner(account).sign(a)).rejects.toThrow(err("signer_mismatch"));
    const own = signIntentAction({
      signerId: v.erc191.address.toUpperCase().replace("0X", "0x"),
      standards: ["nep413"],
    });
    await expect(evmAccountSigner(account).sign(own)).rejects.toThrow(err("signer_mismatch"));
    const broken = { address: v.erc191.address, signMessage: async () => "0x1234" };
    await expect(
      evmAccountSigner(broken).sign(signIntentAction({ signerId: v.erc191.address, standards: ["erc191"] })),
    ).rejects.toThrow(err("signer_mismatch"));
  });

  it("signRefundIntent checks the refund, refuses sign_and_send, and validates the signer's output", async () => {
    const r = refund({ next_action: signIntentAction({ signerId: nearKey.publicKeyHex }) });
    const body = await signRefundIntent(r, nearKeyPairSigner(nearKey.keyPair));
    expect(MultiPayload.parse(body.signed_intent).standard).toBe("nep413");
    await expect(
      signRefundIntent(refund({ next_action: signAndSendAction() }), nearKeyPairSigner(nearKey.keyPair)),
    ).rejects.toThrow(err("wrong_signer"));
    const junk = { standards: ["nep413" as const], sign: async () => ({ standard: "nep413" }) as never };
    await expect(signRefundIntent(r, junk)).rejects.toThrow(err("signer_mismatch"));
  });
});

describe("EVM transfers for sign_and_send", () => {
  const t = (o: Parameters<typeof signAndSendAction>[0] = {}): ChainTransfer =>
    chainTransferOf(signAndSendAction(o) as never);

  it("builds ERC-20 and native transfer requests from the exact action", () => {
    const erc20 = evmTransferRequest(t());
    expect(erc20).toMatchObject({ chainId: 8453, to: USDC_BASE_TOKEN, value: 0n });
    expect(erc20.data).toBe(erc20TransferData("0x1111111111111111111111111111111111111111", 2_000_000n));
    expect(evmTransferRequest(t({ native: true }))).toEqual({
      chainId: 8453,
      from: "0x42e06263bb5346ae6421ab1ec1019824e7b284e1",
      to: "0x1111111111111111111111111111111111111111",
      value: 2_000_000n,
    });
  });

  it("refuses non-EVM chains, memos, other token standards and non-EVM addresses", () => {
    expect(() => evmTransferRequest({ ...t(), chain: "near:mainnet" })).toThrow(err("unsupported_chain"));
    expect(() => evmTransferRequest(t({ memo: "123" }))).toThrow(err("unsupported_chain"));
    expect(() => evmTransferRequest({ ...t(), token: { standard: "spl", address: "x" } })).toThrow(
      err("unsupported_chain"),
    );
    expect(() => evmTransferRequest({ ...t(), token: { standard: "erc20", address: null } })).toThrow(
      err("unsupported_chain"),
    );
    expect(() => evmTransferRequest({ ...t(), to: "merchant.near" })).toThrow(err("invalid_action"));
  });

  it("the wallet sender checks account and chain before sending", async () => {
    const sent: unknown[] = [];
    const wallet = (address: string, chainId: number): EvmWalletLike => ({
      account: { address },
      getChainId: async () => chainId,
      sendTransaction: async (args) => {
        sent.push(args);
        return "0xfeedface00000000";
      },
    });
    const from = "0x42E06263BB5346AE6421AB1EC1019824E7B284E1";
    expect(await evmWalletSender(wallet(from, 8453)).send(t())).toEqual({ txHash: "0xfeedface00000000" });
    expect(sent[0]).toMatchObject({ chain: null, to: USDC_BASE_TOKEN, value: 0n });
    await evmWalletSender(wallet(from, 8453)).send(t({ native: true }));
    expect(sent[1]).not.toHaveProperty("data");
    await expect(evmWalletSender(wallet(from, 1)).send(t())).rejects.toThrow(err("signer_mismatch"));
    await expect(evmWalletSender(wallet("0x0000000000000000000000000000000000000001", 8453)).send(t())).rejects.toThrow(
      err("signer_mismatch"),
    );
    await expect(evmWalletSender({ ...wallet(from, 8453), account: undefined }).send(t())).rejects.toThrow(
      err("signer_mismatch"),
    );
    expect(sent).toHaveLength(2);
  });
});

describe("nearpay.refunds.signers.signAndSubmit (spec mock)", () => {
  let mock: SpecMock;
  let np: NearPay;
  beforeAll(async () => {
    mock = await startSpecMock();
    np = new NearPay("sk_test_signers0123456789", { baseUrl: mock.url, retryBaseMs: 1, retryMaxMs: 2 });
  });
  afterAll(() => mock.close());
  afterEach(() => {
    expect(mock.violations).toEqual([]);
    mock.reset();
  });

  it("retrieves the refund by id, signs the intent and submits it with a per-leg idempotency key", async () => {
    const r = refund({ next_action: signIntentAction({ signerId: nearKey.publicKeyHex }) });
    mock.on(getRefund, () => r);
    mock.on(submitRefundTx, () => ({ ...r, status: "pending" as const, next_action: null }));
    const signer = np.refunds.signers.nearKeyPair(nearKey.keyPair);
    const out = await np.refunds.signers.signAndSubmit(r.id, signer);
    expect(out.status).toBe("pending");
    const call = mock.callsTo(submitRefundTx)[0];
    expect(call?.idempotencyKey).toBe(`${ids.re}-leg-1-submit`);
    const body = call?.body as { signed_intent: { standard: string; payload: { message: string } } };
    expect(body.signed_intent.standard).toBe("nep413");
    expect(body.signed_intent.payload.message).toBe(
      r.next_action?.type === "sign_intent" ? r.next_action.nep413.message : "",
    );
  });

  it("broadcasts a sign_and_send transfer through the sender and reports the hash (and sender)", async () => {
    const r = refund({ next_action: signAndSendAction() });
    mock.on(submitRefundTx, () => ({ ...r, status: "pending" as const, next_action: null }));
    const transfers: ChainTransfer[] = [];
    const sender = {
      send: async (t: ChainTransfer) => {
        transfers.push(t);
        return { txHash: "0xabc123abc123", sender: t.from };
      },
    };
    await np.refunds.signers.signAndSubmit(r, sender, { idempotencyKey: "custom-key" });
    expect(transfers[0]).toMatchObject({
      amount: 2_000_000n,
      to: "0x1111111111111111111111111111111111111111",
      memo: null,
    });
    const call = mock.callsTo(submitRefundTx)[0];
    expect(call?.body).toEqual({ tx_hash: "0xabc123abc123", sender: "0x42e06263bb5346ae6421ab1ec1019824e7b284e1" });
    expect(call?.idempotencyKey).toBe("custom-key");
    mock.on(submitRefundTx, () => r);
    await np.refunds.signers.signAndSubmit(r, { send: async () => ({ txHash: "0xabc123abc124" }) });
    expect(mock.callsTo(submitRefundTx)[1]?.body).toEqual({ tx_hash: "0xabc123abc124" });
  });

  it("after a broadcast, a failed report is submit_failed with the tx hash (never sent twice)", async () => {
    const r = refund({ next_action: signAndSendAction() });
    mock.on(submitRefundTx, () => {
      throw new MockApiError("leg_expired");
    });
    let sends = 0;
    const e = await np.refunds.signers
      .signAndSubmit(r, { send: async () => ({ txHash: `0xdead${++sends}beef00` }) })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NearPayRefundSigningError);
    expect((e as NearPayRefundSigningError).code).toBe("submit_failed");
    expect((e as NearPayRefundSigningError).txHash).toBe("0xdead1beef00");
    expect(sends).toBe(1);
    const noHash = await np.refunds.signers
      .signAndSubmit(r, { send: async () => ({ txHash: "" }) })
      .catch((x: unknown) => x);
    expect((noHash as NearPayRefundSigningError).code).toBe("submit_failed");
  });

  it("refuses a signer of the wrong kind, and refunds with nothing to sign", async () => {
    const intent = refund({ next_action: signIntentAction({ signerId: nearKey.publicKeyHex }) });
    const send = refund({ next_action: signAndSendAction() });
    await expect(np.refunds.signers.signAndSubmit(intent, { send: async () => ({ txHash: "0x1" }) })).rejects.toThrow(
      err("wrong_signer"),
    );
    await expect(
      np.refunds.signers.signAndSubmit(send, np.refunds.signers.nearKeyPair(nearKey.keyPair)),
    ).rejects.toThrow(err("wrong_signer"));
    await expect(np.refunds.signers.signAndSubmit(send, {} as never)).rejects.toThrow(err("wrong_signer"));
    await expect(np.refunds.signers.signAndSubmit(refund(), { send: async () => ({ txHash: "0x1" }) })).rejects.toThrow(
      err("no_action"),
    );
    expect(mock.callsTo(submitRefundTx)).toHaveLength(0);
    expect(np.refunds.signers.check(intent).leg).toBe(1);
    expect(np.refunds.signers.chainTransfer(signAndSendAction() as never).amount).toBe(2_000_000n);
    expect(
      np.refunds.signers.evmTransferRequest(np.refunds.signers.chainTransfer(signAndSendAction() as never)).chainId,
    ).toBe(8453);
    expect(typeof np.refunds.signers.evmAccount).toBe("function");
    expect(typeof np.refunds.signers.evmWallet).toBe("function");
    expect(typeof np.refunds.signers.signIntent).toBe("function");
  });
});
