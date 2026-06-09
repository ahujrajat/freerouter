import { createHash } from 'node:crypto'

/** Returns the SHA-256 of `s` as two 32-bit halves [lo, hi] of the first 64 bits. */
function sha256u64(s: string): [number, number] {
  const h = createHash('sha256').update(s).digest()
  return [h.readUInt32LE(0), h.readUInt32LE(4)]
}

/**
 * SimHash-like 64-bit fingerprint over normalized text. Stable across
 * whitespace, case, and minor edits; sensitive to topical content.
 * Returns a 16-char zero-padded lowercase hex string.
 */
export function simhash64(text: string): string {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  if (tokens.length === 0) return '0000000000000000'
  const bits = new Int32Array(64)
  for (const tok of tokens) {
    const h = sha256u64(tok)
    for (let i = 0; i < 64; i++) {
      const bit = (h[i < 32 ? 0 : 1]! >> (i % 32)) & 1
      bits[i]! += bit === 1 ? 1 : -1
    }
  }
  let lo = 0, hi = 0
  for (let i = 0; i < 32; i++) if (bits[i]! > 0) lo |= 1 << i
  for (let i = 32; i < 64; i++) if (bits[i]! > 0) hi |= 1 << (i - 32)
  const sig = (BigInt.asUintN(32, BigInt(hi >>> 0)) << 32n) | BigInt.asUintN(32, BigInt(lo >>> 0))
  return sig.toString(16).padStart(16, '0')
}

/** Number of differing bits between two 16-char hex SimHash strings. */
export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`)
  let count = 0
  while (x > 0n) {
    x &= x - 1n
    count++
  }
  return count
}
