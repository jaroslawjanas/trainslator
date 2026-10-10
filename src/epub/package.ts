import path from "node:path";
import type { Element } from "domhandler";
import {
  decodeText,
  findAll,
  findFirst,
  getAttr,
  isElement,
  localName,
  parseXml,
  textContent,
} from "./xhtml.ts";

export interface ManifestItem {
  id: string;
  /** Path inside the archive (resolved and percent-decoded). */
  path: string;
  rawHref: string;
  mediaType: string;
  properties: string[];
  mediaOverlay: string | null;
}

export interface SpineItem {
  idref: string;
  linear: boolean;
  path: string | null;
  properties: string[];
}

export interface PackageInfo {
  opfPath: string;
  version: string;
  uniqueIdentifierId: string | null;
  identifier: string | null;
  titles: string[];
  languages: string[];
  manifest: ManifestItem[];
  spine: SpineItem[];
  pageProgression: string | null;
  fixedLayout: boolean;
  navPath: string | null;
  ncxPath: string | null;
  hasMediaOverlays: boolean;
}

export interface ResolvedHref {
  path: string;
  fragment: string | null;
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Resolves an href found in `baseFile` to an archive path. Returns null for
 * external links (http:, mailto:, …) and empty hrefs.
 */
export function resolveHref(baseFile: string, href: string): ResolvedHref | null {
  const decoded = decodeText(href).trim();
  if (!decoded) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded)) return null;
  const hash = decoded.indexOf("#");
  const rawPath = hash >= 0 ? decoded.slice(0, hash) : decoded;
  const fragment = hash >= 0 ? safeDecodeUri(decoded.slice(hash + 1)) || null : null;
  const pathPart = rawPath.split("?")[0] ?? "";
  if (!pathPart) return { path: baseFile, fragment };
  const joined = path.posix.normalize(
    path.posix.join(path.posix.dirname(baseFile), safeDecodeUri(pathPart)),
  );
  return { path: joined.replace(/^(\.\/)+/, "").replace(/^\/+/, ""), fragment };
}

/** Relative href from one archive path to another (for writing links). */
export function relativeHref(fromFile: string, toPath: string): string {
  const rel = path.posix.relative(path.posix.dirname(fromFile), toPath);
  return rel
    .split("/")
    .map((s) => encodeURIComponent(s).replace(/%2F/g, "/"))
    .join("/");
}

export function findOpfPath(containerXml: string): string {
  const doc = parseXml(containerXml);
  const rootfiles = findAll(doc, (el) => localName(el) === "rootfile");
  const opf =
    rootfiles.find((el) => (getAttr(el, "media-type") ?? "") === "application/oebps-package+xml") ??
    rootfiles[0];
  const fullPath = opf ? getAttr(opf, "full-path") : undefined;
  if (!fullPath) throw new Error("META-INF/container.xml doesn't name a package (OPF) file.");
  return safeDecodeUri(decodeText(fullPath)).replace(/^\/+/, "");
}

function metadataValues(metadata: Element | null, local: string): string[] {
  if (!metadata) return [];
  return findAll(metadata, (el) => localName(el) === local && el.name.includes(":"))
    .concat(findAll(metadata, (el) => el.name.toLowerCase() === local))
    .map((el) => textContent(el).trim())
    .filter(Boolean);
}

export function parsePackage(opfSrc: string, opfPath: string): PackageInfo {
  const doc = parseXml(opfSrc);
  const pkg = findFirst(doc, (el) => localName(el) === "package");
  if (!pkg) throw new Error("The package (OPF) file has no <package> element.");
  const version = getAttr(pkg, "version") ?? "2.0";
  const uniqueIdentifierId = getAttr(pkg, "unique-identifier") ?? null;
  const metadata = findFirst(pkg, (el) => localName(el) === "metadata");

  const identifiers = metadata
    ? findAll(
        metadata,
        (el) => localName(el) === "identifier" && el.name.toLowerCase().startsWith("dc:"),
      )
    : [];
  const mainIdentifier =
    identifiers.find(
      (el) => uniqueIdentifierId !== null && getAttr(el, "id") === uniqueIdentifierId,
    ) ?? identifiers[0];

  const metas = metadata ? findAll(metadata, (el) => localName(el) === "meta") : [];
  const fixedLayout = metas.some(
    (m) =>
      getAttr(m, "property") === "rendition:layout" && textContent(m).trim() === "pre-paginated",
  );

  const manifestEl = findFirst(pkg, (el) => localName(el) === "manifest");
  const manifest: ManifestItem[] = [];
  if (manifestEl) {
    for (const child of manifestEl.children) {
      if (!isElement(child) || localName(child) !== "item") continue;
      const href = getAttr(child, "href") ?? "";
      const resolved = resolveHref(opfPath, href);
      if (!resolved) continue;
      manifest.push({
        id: getAttr(child, "id") ?? "",
        path: resolved.path,
        rawHref: href,
        mediaType: (getAttr(child, "media-type") ?? "").trim().toLowerCase(),
        properties: (getAttr(child, "properties") ?? "").split(/\s+/).filter(Boolean),
        mediaOverlay: getAttr(child, "media-overlay") ?? null,
      });
    }
  }
  const byId = new Map(manifest.map((m) => [m.id, m]));

  const spineEl = findFirst(pkg, (el) => localName(el) === "spine");
  const spine: SpineItem[] = [];
  let tocId: string | null = null;
  let pageProgression: string | null = null;
  if (spineEl) {
    tocId = getAttr(spineEl, "toc") ?? null;
    pageProgression = getAttr(spineEl, "page-progression-direction") ?? null;
    for (const child of spineEl.children) {
      if (!isElement(child) || localName(child) !== "itemref") continue;
      const idref = getAttr(child, "idref") ?? "";
      spine.push({
        idref,
        linear: (getAttr(child, "linear") ?? "yes").trim().toLowerCase() !== "no",
        path: byId.get(idref)?.path ?? null,
        properties: (getAttr(child, "properties") ?? "").split(/\s+/).filter(Boolean),
      });
    }
  }
  const spineFixed =
    spine.length > 0 && spine.every((s) => s.properties.includes("rendition:layout-pre-paginated"));

  const nav = manifest.find((m) => m.properties.includes("nav"));
  const ncx =
    (tocId ? byId.get(tocId) : undefined) ??
    manifest.find((m) => m.mediaType === "application/x-dtbncx+xml");

  return {
    opfPath,
    version,
    uniqueIdentifierId,
    identifier: mainIdentifier ? textContent(mainIdentifier).trim() : null,
    titles: metadataValues(metadata, "title"),
    languages: metadataValues(metadata, "language"),
    manifest,
    spine,
    pageProgression,
    fixedLayout: fixedLayout || spineFixed,
    navPath: nav?.path ?? null,
    ncxPath: ncx?.path ?? null,
    hasMediaOverlays:
      manifest.some((m) => m.mediaType === "application/smil+xml" || m.mediaOverlay !== null) ||
      metas.some((m) => (getAttr(m, "property") ?? "").startsWith("media:")),
  };
}

export const XHTML_TYPES = new Set([
  "application/xhtml+xml",
  "text/html",
  "application/x-dtbook+xml",
]);
