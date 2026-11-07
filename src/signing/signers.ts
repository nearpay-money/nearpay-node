/**
 * `nearpay.refunds.signers`: the refund signing helpers of `./refunds.ts` bound to a client, plus
 * `signAndSubmit`, which signs (or broadcasts) a refund's current leg and reports it in one call.
 */
import type { Refund } from "@nearpay/spec";
import type { RequestOptions } from "../http/transport.js";
import {
  type CheckOptions,
  chainTransferOf,
  checkRefundAction,
  evmAccountSigner,
  evmTransferRequest,
  evmWalletSender,
  type IntentSigner,
  NearPayRefundSigningError,
  nearKeyPairSigner,
  signRefundIntent,
  type TransferSender,
} from "./refunds.js";

type SubmitBody = { tx_hash: string; sender?: string } | { signed_intent: unknown };

/** The two refund methods `signAndSubmit` needs (structural, so tests can pass fakes). */
export interface RefundCalls {
  retrieve(id: string, options?: RequestOptions): Promise<Refund>;
  submitTx(id: string, body: never, options?: RequestOptions): Promise<Refund>;
}

export type SignAndSubmitOptions = CheckOptions &
  Omit<RequestOptions, "idempotencyKey"> & {
    /** Default `<refund id>-leg-<n>-submit`, so repeating the report of one leg is replayed, not re-applied. */
    readonly idempotencyKey?: string;
  };

function isIntentSigner(s: unknown): s is IntentSigner {
  return typeof s === "object" && s !== null && typeof (s as IntentSigner).sign === "function";
}

function isSender(s: unknown): s is TransferSender {
  return typeof s === "object" && s !== null && typeof (s as TransferSender).send === "function";
}

export function refundSigners(refunds: RefundCalls) {
  return Object.freeze({
    /** Validates a refund's `next_action` (throws `NearPayRefundSigningError`); nothing is signed. */
    check: checkRefundAction,
    /** Signs a `sign_intent` action; returns `{signed_intent}` for `refunds.submitTx`. */
    signIntent: signRefundIntent,
    /** The exact transfer of a `sign_and_send` action. */
    chainTransfer: chainTransferOf,
    /** EVM transaction request for a transfer (native or ERC-20). */
    evmTransferRequest,
    /** `IntentSigner` from a NEAR `KeyPair` (NEP-413, or raw ed25519). */
    nearKeyPair: nearKeyPairSigner,
    /** `IntentSigner` from a viem `Account` (ERC-191). */
    evmAccount: evmAccountSigner,
    /** `TransferSender` from a viem `WalletClient`. */
    evmWallet: evmWalletSender,

    /**
     * Signs (`sign_intent`) or broadcasts (`sign_and_send`) the current leg of a refund and reports
     * it with `refunds.submitTx`. Pass the refund id to act on its current state (retrieved first),
     * or a refund object you have just retrieved. Never call it twice for one leg after a
     * `submit_failed` error: the transfer was already sent (`error.txHash`).
     */
    async signAndSubmit(
      refundOrId: Refund | string,
      signer: IntentSigner | TransferSender,
      options: SignAndSubmitOptions = {},
    ): Promise<Refund> {
      const { minSecondsLeft, now, idempotencyKey, ...request } = options;
      const refund = typeof refundOrId === "string" ? await refunds.retrieve(refundOrId, request) : refundOrId;
      const checked = checkRefundAction(refund, { minSecondsLeft, now });
      const key = idempotencyKey ?? `${refund.id}-leg-${checked.leg ?? "current"}-submit`;
      let body: SubmitBody;
      if (checked.action.type === "sign_intent") {
        if (!isIntentSigner(signer)) {
          throw new NearPayRefundSigningError(
            "wrong_signer",
            "this refund needs a signed intent: pass an IntentSigner",
          );
        }
        body = await signRefundIntent(refund, signer, { minSecondsLeft, now });
      } else {
        if (!isSender(signer)) {
          throw new NearPayRefundSigningError(
            "wrong_signer",
            "this refund needs a chain transfer: pass a TransferSender",
          );
        }
        const sent = await signer.send(chainTransferOf(checked.action));
        if (typeof sent?.txHash !== "string" || sent.txHash.length === 0) {
          throw new NearPayRefundSigningError("submit_failed", "the sender returned no transaction hash");
        }
        body = sent.sender ? { tx_hash: sent.txHash, sender: sent.sender } : { tx_hash: sent.txHash };
        try {
          return await refunds.submitTx(refund.id, body as never, { ...request, idempotencyKey: key });
        } catch (e) {
          throw new NearPayRefundSigningError(
            "submit_failed",
            `transfer ${sent.txHash} was sent but reporting it failed (${(e as Error).message}); do not send again — report it with refunds.submitTx`,
            { txHash: sent.txHash, cause: e },
          );
        }
      }
      return refunds.submitTx(refund.id, body as never, { ...request, idempotencyKey: key });
    },
  });
}

export type RefundSigners = ReturnType<typeof refundSigners>;
