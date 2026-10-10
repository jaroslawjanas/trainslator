import { createHash, randomUUID } from "node:crypto";
import { FONT_OBFUSCATION_ADOBE, FONT_OBFUSCATION_IDPF, type ObfuscatedFont } from "./inspect.ts";

/**
 * Font obfuscation keys depend on the book's identifier, so giving the
 * translation a new identifier means re-obfuscating embedded fonts.
 *   IDPF:  XOR the first 1040 bytes with SHA-1(identifier without whitespace)
 *   Adobe: XOR the first 1024 bytes with the 16 bytes of the identifier's UUID
 */

export function idpfKey(identifier: string): Uint8Array {
  const clean = identifier.replace(/[ \t\r\n]/g, "");
  return new Uint8Array(createHash("sha1").update(clean, "utf8").digest());
}

export function adobeKey(identifier: string): Uint8Array | null {
  const hex = identifier
    .trim()
    .replace(/^urn:uuid:/i, "")
    .replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) key[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return key;
}

function xorPrefix(data: Uint8Array, key: Uint8Array, length: number): Uint8Array {
  const out = data.slice();
  const n = Math.min(length, out.length);
  for (let i = 0; i < n; i++) out[i] = out[i]! ^ key[i % key.length]!;
  return out;
}

export function keyFor(
  algorithm: ObfuscatedFont["algorithm"],
  identifier: string,
): Uint8Array | null {
  return algorithm === FONT_OBFUSCATION_IDPF ? idpfKey(identifier) : adobeKey(identifier);
}

/** XORing twice with the same key restores the original, so this both obfuscates and de-obfuscates. */
export function obfuscate(
  data: Uint8Array,
  algorithm: ObfuscatedFont["algorithm"],
  key: Uint8Array,
): Uint8Array {
  return xorPrefix(data, key, algorithm === FONT_OBFUSCATION_ADOBE ? 1024 : 1040);
}

/** Re-obfuscates a font from one identifier to another. Null if a key can't be derived. */
export function reobfuscate(
  data: Uint8Array,
  algorithm: ObfuscatedFont["algorithm"],
  oldIdentifier: string,
  newIdentifier: string,
): Uint8Array | null {
  const oldKey = keyFor(algorithm, oldIdentifier);
  const newKey = keyFor(algorithm, newIdentifier);
  if (!oldKey || !newKey) return null;
  return obfuscate(obfuscate(data, algorithm, oldKey), algorithm, newKey);
}

export function newBookIdentifier(): string {
  return `urn:uuid:${randomUUID()}`;
}
