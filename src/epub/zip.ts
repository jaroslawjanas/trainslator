import { inflateSync, type Zippable, zipSync } from "fflate";

/**
 * Minimal ZIP reader/writer for EPUBs. Reading parses the central directory
 * ourselves so that entry order and names are preserved exactly (UTF-8 names
 * without the UTF-8 flag are common in EPUBs) and size limits can be enforced
 * before inflating anything.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  /** 0 = stored, 8 = deflated, as found in the source archive. */
  method: number;
}

export interface ZipLimits {
  maxEntries: number;
  maxTotalUncompressed: number;
  maxEntryUncompressed: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 10_000,
  maxTotalUncompressed: 2 * 1024 * 1024 * 1024,
  maxEntryUncompressed: 512 * 1024 * 1024,
};

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const utf8 = new TextDecoder("utf-8");

function decodeName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return utf8.decode(bytes);
  try {
    // Many tools write UTF-8 names without setting the flag.
    return utf8Strict.decode(bytes);
  } catch {
    let out = "";
    for (const b of bytes) out += String.fromCharCode(b);
    return out;
  }
}

export function readZip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minEocd = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= minEocd; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("Not a ZIP archive (no end of central directory found).");

  const entryCount = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new ZipError("ZIP64 archives aren't supported.");
  }
  if (entryCount > limits.maxEntries) {
    throw new ZipError(`The archive has too many entries (${entryCount}).`);
  }

  const entries: ZipEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== SIG_CENTRAL) {
      throw new ZipError("Corrupt ZIP central directory.");
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decodeName(bytes.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new ZipError(`"${name}" is encrypted (password-protected ZIP).`);
    if (name.endsWith("/")) continue; // directory entry
    if (size > limits.maxEntryUncompressed) {
      throw new ZipError(`"${name}" is too large when uncompressed.`);
    }
    total += size;
    if (total > limits.maxTotalUncompressed) {
      throw new ZipError("The archive is too large when uncompressed.");
    }

    if (view.getUint32(localOffset, true) !== SIG_LOCAL) {
      throw new ZipError(`Corrupt local header for "${name}".`);
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = bytes.subarray(start, start + compSize);

    let data: Uint8Array;
    if (method === 0) {
      data = compressed.slice();
    } else if (method === 8) {
      data = inflateSync(compressed, { out: new Uint8Array(size) });
    } else {
      throw new ZipError(`"${name}" uses an unsupported compression method (${method}).`);
    }
    if (data.length !== size) throw new ZipError(`"${name}" has the wrong uncompressed size.`);
    entries.push({ name, data, method });
  }
  return entries;
}

const encoder = new TextEncoder();

/**
 * Writes an EPUB archive: `mimetype` first, stored, with no extra field;
 * everything else deflated, in the given order.
 */
export function writeEpubZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const files: Zippable = {};
  files.mimetype = [encoder.encode("application/epub+zip"), { level: 0 }];
  for (const entry of entries) {
    if (entry.name === "mimetype") continue;
    files[entry.name] = [entry.data, { level: 6 }];
  }
  return zipSync(files, { mtime: new Date("2000-01-01T00:00:00Z") });
}

export function textOf(entry: { data: Uint8Array }): string {
  return utf8.decode(entry.data);
}
