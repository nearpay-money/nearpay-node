/**
 * Byte encodings the refund signers need, without runtime dependencies: base58 (NEAR keys and
 * signatures, `<curve>:<base58>`), the NEP-413 message hash, and EVM helpers (ERC-191 signature
 * normalisation, ERC-20 `transfer` calldata).
 */
import { createHash } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

/** Bitcoin-alphabet base58 of `bytes`. */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return "1".repeat(zeros) + out;
}

/** Decodes base58; throws on characters outside the alphabet. */
export function base58Decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  let n = 0n;
  for (const c of text) {
    const v = INDEX.get(c);
    if (v === undefined) throw new Error(`invalid base58 character ${JSON.stringify(c)}`);
    n = n * 58n + BigInt(v);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function borshString(s: string): Buffer {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([u32le(bytes.length), bytes]);
}

/** NEP-413 tag: 2^31 + 413. */
export const NEP413_TAG = 2_147_484_061;

/**
 * The 32-byte NEP-413 hash an ed25519 key signs:
 * `sha256(borsh(u32 tag) ‖ borsh({message: string, nonce: [u8; 32], recipient: string, callback_url: Option<string>}))`.
 */
export function nep413Hash(p: {
  readonly message: string;
  readonly nonce: Uint8Array;
  readonly recipient: string;
  readonly callbackUrl?: string | null;
}): Buffer {
  if (p.nonce.length !== 32) throw new Error("NEP-413 nonce must be 32 bytes");
  const callback =
    p.callbackUrl === undefined || p.callbackUrl === null
      ? Buffer.from([0])
      : Buffer.concat([Buffer.from([1]), borshString(p.callbackUrl)]);
  const bytes = Buffer.concat([
    u32le(NEP413_TAG),
    borshString(p.message),
    Buffer.from(p.nonce),
    borshString(p.recipient),
    callback,
  ]);
  return createHash("sha256").update(bytes).digest();
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("invalid hex string");
  return Uint8Array.from(Buffer.from(h, "hex"));
}

/**
 * An ERC-191 signature (`0x` r‖s‖v, v ∈ {27, 28} or {0, 1}) in the Verifier's form: r‖s‖v with
 * v ∈ {0, 1} and a low s (s > n/2 → s = n − s, v ^= 1).
 */
export function normalizeErc191Signature(signature: string): Uint8Array {
  const sig = hexToBytes(signature);
  if (sig.length !== 65) throw new Error("an ERC-191 signature has 65 bytes (r‖s‖v)");
  let v = sig[64] as number;
  if (v === 27 || v === 28) v -= 27;
  if (v !== 0 && v !== 1) throw new Error(`invalid ERC-191 recovery id ${sig[64]}`);
  let s = BigInt(`0x${Buffer.from(sig.subarray(32, 64)).toString("hex")}`);
  if (s === 0n || s >= SECP256K1_N) throw new Error("invalid ERC-191 signature (s out of range)");
  if (s > SECP256K1_N / 2n) {
    s = SECP256K1_N - s;
    v ^= 1;
  }
  const out = new Uint8Array(65);
  out.set(sig.subarray(0, 32), 0);
  out.set(hexToBytes(s.toString(16).padStart(64, "0")), 32);
  out[64] = v;
  return out;
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddress(a: string): a is `0x${string}` {
  return EVM_ADDRESS_RE.test(a);
}

/** ABI calldata of ERC-20 `transfer(address to, uint256 amount)`. */
export function erc20TransferData(to: string, amount: bigint): `0x${string}` {
  if (!isEvmAddress(to)) throw new Error(`not an EVM address: ${to}`);
  if (amount < 0n || amount >= 2n ** 256n) throw new Error("amount out of uint256 range");
  return `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
}
