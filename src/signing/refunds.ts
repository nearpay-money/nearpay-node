/**
 * Refund signing helpers (`nearpay.refunds.signers`, lld/sdks-and-tools.md §1; payments §17).
 *
 * NearPay never holds merchant funds (INV-1): a refund leg's `next_action` says exactly what the
 * merchant must sign with the wallet behind its settlement destination, and NearPay only relays it.
 * These helpers take that `next_action` and a signer **you** provide, and never construct a different
 * recipient, asset or amount:
 *
 * - `sign_intent` (Intents-account destinations): the exact NEP-413 arguments or the exact
 *   ERC-191 / raw-ed25519 string from the API are signed verbatim, after checking that they encode
 *   the one transfer the action displays (`transfer`, `display`) — so the human-readable summary is
 *   what gets signed — and, for `intents_transfer` refunds, that the receiver is the payer's recorded
 *   refund account (INV-7). The result is submitted with `refunds.submitTx({signed_intent})`.
 * - `sign_and_send` (chain-address destinations): the transfer `{chain, from, to, asset, amount,
 *   memo}` is handed to your sender unchanged (EVM: a native or ERC-20 transfer built here), then the
 *   transaction hash is reported with `refunds.submitTx({tx_hash})`.
 *
 * Every helper first checks the refund: status `requires_action`, a `next_action`, a current leg
 * awaiting its signature with nothing submitted yet (so a retry never broadcasts a second transfer),
 * the leg amount equal to the action amount, and a deadline far enough ahead.
 *
 * Signers are structural (no runtime dependency): a NEAR `KeyPair` (`near-api-js`, `@near-js/crypto`),
 * a viem `Account` (`privateKeyToAccount`, or any `{address, signMessage}`), a viem `WalletClient`
 * (`{account, getChainId, sendTransaction}`), or your own `TransferSender`.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import {
  INTENTS_CONTRACT,
  MultiPayload,
  type Refund,
  RefundNextAction,
  safeParseTolerant,
  type MultiPayload as TMultiPayload,
} from "@nearpay-money/spec";
import { NearPayError } from "../http/errors.js";
import {
  base58Decode,
  base58Encode,
  erc20TransferData,
  isEvmAddress,
  nep413Hash,
  normalizeErc191Signature,
} from "./encoding.js";

export type RefundSignIntentAction = Extract<RefundNextAction, { type: "sign_intent" }>;
export type RefundSignAndSendAction = Extract<RefundNextAction, { type: "sign_and_send" }>;
type Standard = RefundSignIntentAction["standards"][number];

/** A refund could not be signed safely; nothing was signed or sent. */
export class NearPayRefundSigningError extends NearPayError {
  /**
   * Set with code `submit_failed`: the transfer **was broadcast** but reporting it failed. Do not
   * send again; report it later with `refunds.submitTx(id, {tx_hash})` (detection does not depend on it).
   */
  readonly txHash: string | undefined;
  constructor(code: string, message: string, o: { readonly txHash?: string; readonly cause?: unknown } = {}) {
    super({ message, type: "refund_signing_error", code, cause: o.cause });
    this.txHash = o.txHash;
  }
}

const fail = (code: string, message: string): never => {
  throw new NearPayRefundSigningError(code, message);
};

export interface CheckOptions {
  /** Refuse when fewer seconds than this remain before the leg's deadline; default 60. */
  readonly minSecondsLeft?: number;
  /** Current unix time in seconds (tests); default the system clock. */
  readonly now?: number;
}

/** The checked `next_action` of a refund, with the leg it belongs to. */
export interface CheckedRefundAction<A extends RefundNextAction = RefundNextAction> {
  readonly refund: Refund;
  readonly action: A;
  /** The current leg's number (1-based), when the refund lists its legs. */
  readonly leg: number | undefined;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fail("payload_mismatch", `${what} is not valid JSON`);
  }
}

/** Checks that the strings to sign encode exactly the displayed transfer (see the module comment). */
function checkSignIntent(refund: Refund, a: RefundSignIntentAction, now: number, minLeft: number): void {
  const m = a.message;
  if (canonical(parseJson(a.payload, "next_action.payload")) !== canonical(m)) {
    fail("payload_mismatch", "next_action.payload does not encode next_action.message");
  }
  const nep = parseJson(a.nep413.message, "next_action.nep413.message");
  if (canonical(nep) !== canonical({ signer_id: m.signer_id, deadline: m.deadline, intents: m.intents })) {
    fail("payload_mismatch", "next_action.nep413.message does not encode next_action.message");
  }
  if (a.nep413.nonce !== m.nonce) fail("payload_mismatch", "the NEP-413 nonce differs from the message nonce");
  if (a.nep413.recipient !== INTENTS_CONTRACT || m.verifying_contract !== INTENTS_CONTRACT) {
    fail("payload_mismatch", `the payload must be addressed to ${INTENTS_CONTRACT}`);
  }
  if (m.signer_id !== a.signer_id) fail("payload_mismatch", "the message signer differs from next_action.signer_id");
  const intent = m.intents.length === 1 ? (m.intents[0] as Record<string, unknown>) : undefined;
  if (intent?.intent !== "transfer") fail("payload_mismatch", "the payload must hold exactly one transfer");
  const t = intent as { receiver_id?: unknown; tokens?: unknown; memo?: unknown };
  if (t.receiver_id !== a.transfer.receiver_id)
    fail("payload_mismatch", "the payload's receiver differs from transfer");
  if (canonical(t.tokens) !== canonical({ [a.transfer.token]: a.transfer.amount })) {
    fail("payload_mismatch", "the payload's token or amount differs from transfer");
  }
  if (t.memo !== a.transfer.memo) fail("payload_mismatch", "the payload's memo differs from transfer.memo");
  const deadline = Date.parse(m.deadline) / 1000;
  if (!Number.isFinite(deadline) || Math.abs(deadline - a.deadline) > 1) {
    fail("payload_mismatch", "the payload's deadline differs from next_action.deadline");
  }
  if (refund.method === "intents_transfer" && a.transfer.receiver_id !== refund.recipient.address) {
    fail("recipient_mismatch", "the transfer does not go to the payer's recorded refund account");
  }
  if (a.transfer.token !== refund.asset_id)
    fail("payload_mismatch", "the transfer asset differs from the refund asset");
  if (a.deadline - now < minLeft)
    fail("deadline_passed", "the leg's deadline has passed or is too close; prepare a new leg");
}

function checkSignAndSend(refund: Refund, a: RefundSignAndSendAction, now: number, minLeft: number): void {
  if (a.asset_id !== refund.asset_id) fail("payload_mismatch", "the transfer asset differs from the refund asset");
  if (a.deadline - now < minLeft)
    fail("deadline_passed", "the leg's deadline has passed or is too close; prepare a new leg");
}

/**
 * Validates a refund's `next_action` before anything is signed (see the module comment) and returns it.
 * Throws `NearPayRefundSigningError` (`no_action`, `invalid_action`, `already_submitted`,
 * `payload_mismatch`, `recipient_mismatch`, `deadline_passed`).
 */
export function checkRefundAction(refund: Refund, options: CheckOptions = {}): CheckedRefundAction {
  if (refund === null || typeof refund !== "object" || refund.object !== "refund") {
    fail("invalid_action", "pass a refund object (from refunds.create / retrieve / prepare)");
  }
  if (refund.status !== "requires_action" || refund.next_action === null || refund.next_action === undefined) {
    fail(
      "no_action",
      `refund ${refund.id} has nothing to sign (status ${refund.status}); retrieve it again or prepare a new leg`,
    );
  }
  const parsed = safeParseTolerant(RefundNextAction, refund.next_action);
  if (!parsed.success) {
    return fail(
      "invalid_action",
      `next_action does not match @nearpay-money/spec: ${parsed.error.issues[0]?.message ?? ""}`,
    );
  }
  const action = parsed.data;
  const leg = Array.isArray(refund.legs) ? refund.legs[0] : undefined;
  if (leg) {
    if (leg.status !== "awaiting_signature" || leg.submitted_tx) {
      fail("already_submitted", `leg ${leg.number} of ${refund.id} is ${leg.status}; nothing is signed twice`);
    }
    const amount = action.type === "sign_intent" ? action.transfer.amount : action.amount;
    if (leg.amount !== amount) fail("payload_mismatch", "the action amount differs from the current leg's amount");
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const minLeft = options.minSecondsLeft ?? 60;
  if (action.type === "sign_intent") checkSignIntent(refund, action, now, minLeft);
  else checkSignAndSend(refund, action, now, minLeft);
  return { refund, action, leg: leg?.number };
}

// ---------------------------------------------------------------------------------------------
// Signers for `sign_intent`
// ---------------------------------------------------------------------------------------------

/** Signs a checked `sign_intent` action; returns the `MultiPayload` to submit. */
export interface IntentSigner {
  /** Standards this signer can produce, in order of preference. */
  readonly standards: readonly Standard[];
  sign(action: RefundSignIntentAction): Promise<TMultiPayload>;
}

/** A NEAR key pair (`near-api-js` / `@near-js/crypto` `KeyPair`): signs raw bytes with ed25519. */
export interface NearKeyPairLike {
  sign(message: Uint8Array): { readonly signature: Uint8Array };
  getPublicKey(): { toString(): string };
}

/** An EVM account that signs ERC-191 `personal_sign` messages (viem `Account`). */
export interface EvmMessageAccountLike {
  readonly address: string;
  signMessage(args: { message: string }): Promise<string>;
}

function ed25519PublicKey(keyPair: NearKeyPairLike): Uint8Array {
  const text = keyPair.getPublicKey().toString();
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(text);
  const key = m ? base58Decode(m[1] as string) : undefined;
  if (key?.length !== 32) return fail("signer_mismatch", "the NEAR key pair must hold an ed25519 key");
  return key;
}

function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey).toString("base64url") },
      format: "jwk",
    });
    return cryptoVerify(null, message, key, signature);
  } catch {
    return false;
  }
}

/**
 * A signer for a NEAR Intents account held by an ed25519 key pair. Uses NEP-413 when the action
 * accepts it (else `raw_ed25519`); verifies its own signature, and for an implicit account
 * (64 hex characters) that the key is the account's key. A named account's keys live on
 * `intents.near`; the Verifier checks those when NearPay relays the payload.
 */
export function nearKeyPairSigner(
  keyPair: NearKeyPairLike,
  options: { readonly standard?: Standard } = {},
): IntentSigner {
  const prefer: Standard[] = options.standard ? [options.standard] : ["nep413", "raw_ed25519"];
  return {
    standards: prefer,
    async sign(action) {
      const standard = prefer.find((s) => action.standards.includes(s));
      if (!standard) {
        return fail(
          "signer_mismatch",
          `the action accepts ${action.standards.join(", ")}; a NEAR key pair signs nep413 or raw_ed25519`,
        );
      }
      const pub = ed25519PublicKey(keyPair);
      if (/^[0-9a-f]{64}$/.test(action.signer_id) && Buffer.from(pub).toString("hex") !== action.signer_id) {
        fail("signer_mismatch", `this key pair is not the key of ${action.signer_id}`);
      }
      const message =
        standard === "nep413"
          ? nep413Hash({
              message: action.nep413.message,
              nonce: Buffer.from(action.nep413.nonce, "base64"),
              recipient: action.nep413.recipient,
            })
          : Buffer.from(action.payload, "utf8");
      const { signature } = keyPair.sign(Uint8Array.from(message));
      if (!(signature instanceof Uint8Array) || !verifyEd25519(pub, message, signature)) {
        fail("signer_mismatch", "the key pair's signature does not verify with its public key");
      }
      const public_key = `ed25519:${base58Encode(pub)}`;
      const sig = `ed25519:${base58Encode(signature)}`;
      return standard === "nep413"
        ? {
            standard,
            payload: { recipient: INTENTS_CONTRACT, nonce: action.nep413.nonce, message: action.nep413.message },
            public_key,
            signature: sig,
          }
        : { standard, payload: action.payload, public_key, signature: sig };
    },
  };
}

/**
 * A signer for an EVM-controlled Intents account (`signer_id` = the 0x address): signs the exact
 * payload string with ERC-191 and normalises the signature (v ∈ {0, 1}, low s). The account must be
 * `signer_id`; the signature itself is verified by NearPay and the Verifier before relaying.
 */
export function evmAccountSigner(account: EvmMessageAccountLike): IntentSigner {
  return {
    standards: ["erc191"],
    async sign(action) {
      if (!action.standards.includes("erc191")) {
        return fail(
          "signer_mismatch",
          `the action accepts ${action.standards.join(", ")}; an EVM account signs erc191`,
        );
      }
      if (typeof account.address !== "string" || account.address.toLowerCase() !== action.signer_id.toLowerCase()) {
        fail("signer_mismatch", `this account (${account.address}) is not ${action.signer_id}`);
      }
      const raw = await account.signMessage({ message: action.payload });
      let sig: Uint8Array;
      try {
        sig = normalizeErc191Signature(raw);
      } catch (e) {
        return fail("signer_mismatch", `the account returned an invalid signature: ${(e as Error).message}`);
      }
      return { standard: "erc191", payload: action.payload, signature: `secp256k1:${base58Encode(sig)}` };
    },
  };
}

/** Signs a refund's `sign_intent` action (after `checkRefundAction`); returns the `submitTx` body. */
export async function signRefundIntent(
  refund: Refund,
  signer: IntentSigner,
  options: CheckOptions = {},
): Promise<{ signed_intent: TMultiPayload }> {
  const { action } = checkRefundAction(refund, options);
  if (action.type !== "sign_intent") {
    return fail("wrong_signer", "this refund needs a chain transfer (sign_and_send): use a TransferSender");
  }
  const signed = await signer.sign(action);
  const ok = MultiPayload.safeParse(signed);
  if (!ok.success) return fail("signer_mismatch", "the signer returned a payload that is not a valid MultiPayload");
  return { signed_intent: ok.data };
}

// ---------------------------------------------------------------------------------------------
// Senders for `sign_and_send`
// ---------------------------------------------------------------------------------------------

/** The exact chain transfer of a `sign_and_send` action, as handed to a `TransferSender`. */
export interface ChainTransfer {
  /** CAIP-2 chain id (`eip155:8453`, `near:mainnet`, `solana:…`). */
  readonly chain: string;
  /** Send from this address (the settlement destination). */
  readonly from: string;
  /** Send to this address (the leg's deposit address). */
  readonly to: string;
  readonly assetId: string;
  readonly token: RefundSignAndSendAction["token"];
  readonly symbol: string;
  readonly decimals: number;
  /** Exact amount in base units (INV-5). */
  readonly amount: bigint;
  /** Memo the transfer must carry, or null. */
  readonly memo: string | null;
  /** Unix seconds; a deposit after it is returned to `from`. */
  readonly deadline: number;
  /** Human-readable summary from the API: show it before you send. */
  readonly display: string;
}

/** Broadcasts a chain transfer you control; returns its hash (and the sender, where the chain needs it). */
export interface TransferSender {
  send(transfer: ChainTransfer): Promise<{ readonly txHash: string; readonly sender?: string }>;
}

/** Turns a checked `sign_and_send` action into the transfer to broadcast (nothing changed, amount as bigint). */
export function chainTransferOf(action: RefundSignAndSendAction): ChainTransfer {
  return {
    chain: action.chain,
    from: action.from,
    to: action.to,
    assetId: action.asset_id,
    token: action.token,
    symbol: action.symbol,
    decimals: action.decimals,
    amount: BigInt(action.amount),
    memo: action.memo,
    deadline: action.deadline,
    display: action.display,
  };
}

/** An EVM transaction request (viem `sendTransaction` parameters) for a transfer. */
export interface EvmTransferRequest {
  /** Numeric chain id from the CAIP-2 `eip155:<id>`. */
  readonly chainId: number;
  readonly from: `0x${string}`;
  readonly to: `0x${string}`;
  readonly value: bigint;
  readonly data?: `0x${string}`;
}

/**
 * The EVM transaction for a `sign_and_send` transfer: a native transfer (`value`) or an ERC-20
 * `transfer(to, amount)` call on the token contract. Refuses non-EVM chains, memos (EVM transfers
 * cannot carry them) and token standards other than `native` / `erc20`.
 */
export function evmTransferRequest(transfer: ChainTransfer): EvmTransferRequest {
  const m = /^eip155:([0-9]{1,15})$/.exec(transfer.chain);
  if (!m) return fail("unsupported_chain", `${transfer.chain} is not an EVM chain; use your own TransferSender`);
  if (transfer.memo !== null && transfer.memo !== "") fail("unsupported_chain", "an EVM transfer cannot carry a memo");
  if (!isEvmAddress(transfer.from) || !isEvmAddress(transfer.to))
    fail("invalid_action", "from/to must be EVM addresses");
  const chainId = Number(m[1]);
  const from = transfer.from as `0x${string}`;
  if (transfer.token.standard === "native")
    return { chainId, from, to: transfer.to as `0x${string}`, value: transfer.amount };
  if (transfer.token.standard === "erc20" && transfer.token.address && isEvmAddress(transfer.token.address)) {
    return {
      chainId,
      from,
      to: transfer.token.address,
      value: 0n,
      data: erc20TransferData(transfer.to, transfer.amount),
    };
  }
  return fail(
    "unsupported_chain",
    `token standard ${transfer.token.standard} is not supported on EVM; use your own TransferSender`,
  );
}

/** A viem `WalletClient` (or anything with the same three members). */
export interface EvmWalletLike {
  readonly account?: { readonly address: string } | undefined;
  getChainId(): Promise<number>;
  sendTransaction(args: {
    account: { readonly address: string };
    chain: null;
    to: `0x${string}`;
    value: bigint;
    data?: `0x${string}`;
  }): Promise<string>;
}

/**
 * A sender that broadcasts EVM transfers with a viem `WalletClient`: checks that the wallet's
 * account is `from` and that it is connected to the action's chain, then sends the transaction
 * built by `evmTransferRequest`.
 */
export function evmWalletSender(wallet: EvmWalletLike): TransferSender {
  return {
    async send(transfer) {
      const req = evmTransferRequest(transfer);
      const account = wallet.account;
      if (!account || account.address.toLowerCase() !== req.from.toLowerCase()) {
        return fail("signer_mismatch", `the wallet's account must be ${req.from} (the settlement destination)`);
      }
      const chainId = await wallet.getChainId();
      if (chainId !== req.chainId)
        fail("signer_mismatch", `the wallet is on chain ${chainId}, the refund on ${req.chainId}`);
      const txHash = await wallet.sendTransaction({
        account,
        chain: null,
        to: req.to,
        value: req.value,
        ...(req.data ? { data: req.data } : {}),
      });
      return { txHash };
    },
  };
}
