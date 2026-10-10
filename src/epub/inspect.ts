import { decodeText, findAll, getAttr, localName, parseXml } from "./xhtml.ts";
import type { ZipEntry } from "./zip.ts";

export const FONT_OBFUSCATION_IDPF = "http://www.idpf.org/2008/embedding";
export const FONT_OBFUSCATION_ADOBE = "http://ns.adobe.com/pdf/enc#RC";

export interface ObfuscatedFont {
  path: string;
  algorithm: typeof FONT_OBFUSCATION_IDPF | typeof FONT_OBFUSCATION_ADOBE;
}

export interface EncryptionInfo {
  drm: boolean;
  drmReason: string | null;
  obfuscatedFonts: ObfuscatedFont[];
}

const DRM_FILES: Record<string, string> = {
  "META-INF/rights.xml": "Adobe DRM (rights.xml)",
  "META-INF/sinf.xml": "Apple FairPlay DRM (sinf.xml)",
  "META-INF/license.lcpl": "Readium LCP DRM (license.lcpl)",
};

/** Detects DRM and lists obfuscated fonts (which are allowed and handled). */
export function inspectEncryption(entries: ZipEntry[]): EncryptionInfo {
  const names = new Set(entries.map((e) => e.name));
  for (const [file, reason] of Object.entries(DRM_FILES)) {
    if (names.has(file)) return { drm: true, drmReason: reason, obfuscatedFonts: [] };
  }
  const encryption = entries.find((e) => e.name === "META-INF/encryption.xml");
  if (!encryption) return { drm: false, drmReason: null, obfuscatedFonts: [] };

  const doc = parseXml(new TextDecoder().decode(encryption.data));
  const fonts: ObfuscatedFont[] = [];
  for (const data of findAll(doc, (el) => localName(el) === "encrypteddata")) {
    const method = findAll(data, (el) => localName(el) === "encryptionmethod")[0];
    const reference = findAll(data, (el) => localName(el) === "cipherreference")[0];
    const algorithm = method ? (getAttr(method, "Algorithm") ?? "") : "";
    const uri = reference ? decodeText(getAttr(reference, "URI") ?? "") : "";
    if (algorithm === FONT_OBFUSCATION_IDPF || algorithm === FONT_OBFUSCATION_ADOBE) {
      let p = uri;
      try {
        p = decodeURIComponent(uri);
      } catch {
        // keep raw
      }
      fonts.push({ path: p.replace(/^\/+/, ""), algorithm });
    } else {
      return {
        drm: true,
        drmReason: `encrypted content (${algorithm || "unknown algorithm"})`,
        obfuscatedFonts: [],
      };
    }
  }
  return { drm: false, drmReason: null, obfuscatedFonts: fonts };
}

export interface CssInfo {
  /** Class names whose rules set `white-space: pre…` (simple class selectors only). */
  preClasses: Set<string>;
  hasFontFace: boolean;
  forcesLtr: boolean;
  usesPhysicalLeftRight: boolean;
}

/** Light scan of stylesheets; not a CSS parser. */
export function scanCss(cssTexts: string[]): CssInfo {
  const preClasses = new Set<string>();
  let hasFontFace = false;
  let forcesLtr = false;
  let usesPhysicalLeftRight = false;
  for (const raw of cssTexts) {
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    if (/@font-face/i.test(css)) hasFontFace = true;
    if (/direction\s*:\s*ltr/i.test(css)) forcesLtr = true;
    if (/text-align\s*:\s*(left|right)|float\s*:\s*(left|right)|margin-(left|right)/i.test(css)) {
      usesPhysicalLeftRight = true;
    }
    for (const match of css.matchAll(/([^{}@]+)\{([^}]*)\}/g)) {
      const selectors = match[1] ?? "";
      const body = match[2] ?? "";
      if (!/white-space\s*:\s*pre/i.test(body)) continue;
      for (const selector of selectors.split(",")) {
        const s = selector.trim();
        const simple = /^(?:[a-zA-Z][\w-]*)?\.([\w-]+)$/.exec(s);
        if (simple?.[1]) preClasses.add(simple[1]);
      }
    }
  }
  return { preClasses, hasFontFace, forcesLtr, usesPhysicalLeftRight };
}
