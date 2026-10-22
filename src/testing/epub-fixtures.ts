/**
 * Builds small EPUBs in code for tests. All text is invented for these tests.
 */

const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// Minimal ZIP writer (stored entries) so tests control flags and names exactly
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface RawZipEntry {
  name: string;
  data: Uint8Array;
}

export function storeZip(entries: RawZipEntry[], options: { utf8Flag?: boolean } = {}): Uint8Array {
  const utf8Flag = options.utf8Flag ?? true;
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const flags = utf8Flag && /[^\x20-\x7e]/.test(e.name) ? 0x800 : 0;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, e.data);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length + e.data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...chunks, ...central, eocd];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// EPUB builder
// ---------------------------------------------------------------------------

export interface FixtureDoc {
  /** Path relative to the OPF folder, e.g. "text/ch1.xhtml". */
  path: string;
  /** Manifest href when it differs from the path (e.g. percent-encoded). */
  href?: string;
  /** Body content (ignored when `raw` is given). */
  body?: string;
  /** Complete file content. */
  raw?: string;
  title?: string;
  linear?: boolean;
  inSpine?: boolean;
  /** Extra attributes on <html>, e.g. ` lang="en-US"`. */
  htmlAttrs?: string;
  bodyAttrs?: string;
  headExtra?: string;
}

export interface FixtureToc {
  title: string;
  /** Href relative to the OPF folder, or null for an unlinked heading. */
  href: string | null;
  children?: FixtureToc[];
}

export interface FixtureOptions {
  version?: "2.0" | "3.0";
  title?: string;
  language?: string;
  identifier?: string;
  docs: FixtureDoc[];
  toc?: FixtureToc[];
  /** Write the TOC only as NCX (EPUB 2 style) even for EPUB 3. */
  ncx?: boolean;
  css?: string;
  extraManifest?: {
    id: string;
    path: string;
    mediaType: string;
    data: Uint8Array | string;
    properties?: string;
  }[];
  extraEntries?: RawZipEntry[];
  metadataExtra?: string;
  spineAttrs?: string;
  utf8Flag?: boolean;
  /** Put the navigation document in the spine (some books do). */
  navInSpine?: boolean;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

export function xhtmlDoc(version: "2.0" | "3.0", doc: FixtureDoc, lang: string): string {
  const title = escapeXml(doc.title ?? "Chapter");
  if (version === "2.0") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}"${doc.htmlAttrs ?? ""}>
<head>
<title>${title}</title>
<link rel="stylesheet" type="text/css" href="../style.css"/>${doc.headExtra ?? ""}
</head>
<body${doc.bodyAttrs ?? ""}>
${doc.body ?? ""}
</body>
</html>
`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}"${doc.htmlAttrs ?? ""}>
<head>
<meta charset="utf-8"/>
<title>${title}</title>
<link rel="stylesheet" type="text/css" href="../style.css"/>${doc.headExtra ?? ""}
</head>
<body${doc.bodyAttrs ?? ""}>
${doc.body ?? ""}
</body>
</html>
`;
}

function relFromNav(href: string): string {
  // nav.xhtml lives in the OPF folder, so hrefs are already relative to it.
  return href;
}

function navOl(entries: FixtureToc[]): string {
  const items = entries
    .map((e) => {
      const label = e.href
        ? `<a href="${escapeXml(relFromNav(e.href))}">${escapeXml(e.title)}</a>`
        : `<span>${escapeXml(e.title)}</span>`;
      const kids = e.children?.length ? `\n${navOl(e.children)}` : "";
      return `<li>${label}${kids}</li>`;
    })
    .join("\n");
  return `<ol>\n${items}\n</ol>`;
}

function ncxPoints(entries: FixtureToc[], counter: { n: number }): string {
  return entries
    .filter((e) => e.href)
    .map((e) => {
      counter.n++;
      const n = counter.n;
      const kids = e.children?.length ? ncxPoints(e.children, counter) : "";
      return `<navPoint id="np${n}" playOrder="${n}"><navLabel><text>${escapeXml(e.title)}</text></navLabel><content src="${escapeXml(e.href!)}"/>${kids}</navPoint>`;
    })
    .join("\n");
}

export function buildFixtureEpub(options: FixtureOptions): Uint8Array {
  const version = options.version ?? "3.0";
  const lang = options.language ?? "en";
  const title = options.title ?? "The Lantern Keeper";
  const identifier = options.identifier ?? "urn:uuid:12345678-1234-4234-8234-123456789abc";
  const toc =
    options.toc ??
    options.docs
      .filter((d) => d.inSpine !== false)
      .map((d, i) => ({ title: d.title ?? `Chapter ${i + 1}`, href: d.path }));

  const manifest: string[] = [];
  const spine: string[] = [];
  const files: RawZipEntry[] = [];

  options.docs.forEach((doc, i) => {
    const id = `doc${i}`;
    manifest.push(
      `<item id="${id}" href="${escapeXml(doc.href ?? doc.path)}" media-type="application/xhtml+xml"/>`,
    );
    if (doc.inSpine !== false)
      spine.push(`<itemref idref="${id}"${doc.linear === false ? ' linear="no"' : ""}/>`);
    files.push({
      name: `OEBPS/${doc.path}`,
      data: enc.encode(doc.raw ?? xhtmlDoc(version, doc, lang)),
    });
  });

  files.push({
    name: "OEBPS/style.css",
    data: enc.encode(options.css ?? "p { text-indent: 1em; }\n"),
  });
  manifest.push(`<item id="css" href="style.css" media-type="text/css"/>`);

  const useNav = version === "3.0" && !options.ncx;
  if (useNav) {
    const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}">
<head><title>Contents</title></head>
<body>
<nav epub:type="toc" id="toc"><h1>Contents</h1>
${navOl(toc)}
</nav>
<nav epub:type="landmarks" hidden=""><ol><li><a epub:type="bodymatter" href="${escapeXml(toc.find((t) => t.href)?.href ?? "")}">Start of Content</a></li></ol></nav>
</body>
</html>
`;
    files.push({ name: "OEBPS/nav.xhtml", data: enc.encode(nav) });
    manifest.push(
      `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    );
    if (options.navInSpine) spine.unshift(`<itemref idref="nav"/>`);
  }
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${lang}">
<head><meta name="dtb:uid" content="${escapeXml(identifier)}"/></head>
<docTitle><text>${escapeXml(title)}</text></docTitle>
<navMap>
${ncxPoints(toc, { n: 0 })}
</navMap>
</ncx>
`;
  files.push({ name: "OEBPS/toc.ncx", data: enc.encode(ncx) });
  manifest.push(`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);

  for (const extra of options.extraManifest ?? []) {
    manifest.push(
      `<item id="${extra.id}" href="${escapeXml(extra.path)}" media-type="${extra.mediaType}"${extra.properties ? ` properties="${extra.properties}"` : ""}/>`,
    );
    files.push({
      name: `OEBPS/${extra.path}`,
      data: typeof extra.data === "string" ? enc.encode(extra.data) : extra.data,
    });
  }

  const modified =
    version === "3.0" ? `\n    <meta property="dcterms:modified">2020-01-01T00:00:00Z</meta>` : "";
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${version}" unique-identifier="bookid"${version === "3.0" ? ` xml:lang="${lang}"` : ""}>
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="bookid">${escapeXml(identifier)}</dc:identifier>
    <dc:title id="title">${escapeXml(title)}</dc:title>
    <dc:language>${lang}</dc:language>
    <dc:creator>A. Writer</dc:creator>${modified}${options.metadataExtra ?? ""}
  </metadata>
  <manifest>
    ${manifest.join("\n    ")}
  </manifest>
  <spine toc="ncx"${options.spineAttrs ?? ""}>
    ${spine.join("\n    ")}
  </spine>
</package>
`;
  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`;
  const entries: RawZipEntry[] = [
    { name: "mimetype", data: enc.encode("application/epub+zip") },
    { name: "META-INF/container.xml", data: enc.encode(container) },
    ...(options.extraEntries ?? []),
    { name: "OEBPS/content.opf", data: enc.encode(opf) },
    ...files,
  ];
  return storeZip(entries, { utf8Flag: options.utf8Flag });
}

// ---------------------------------------------------------------------------
// A "kitchen sink" novel with the markup patterns real books use
// ---------------------------------------------------------------------------

export const CHAPTER_ONE = `<section epub:type="chapter" id="ch1">
<h1 class="chapter" id="h1"><a id="p1"/>Chapter One<br/><span class="sub">The Lamp</span></h1>
<p class="first"><span class="dropcap">M</span>ira climbed the hundred steps of the lighthouse every evening, counting them under her breath.</p>
<p>She kept a <i>small</i> notebook, and in it she wrote the names of ships that passed: the <i>Gray Heron</i>, the <i>Morning Bell</i>.<a epub:type="noteref" href="notes.xhtml#n1" id="r1">1</a></p>
<p>The keeper&#8217;s cat was called Pepper&nbsp;&mdash; nobody remembered why.</p>
<p><span class="calibre5">A whole paragraph wrapped in one span, as converters like to do.</span></p>
<p>Some words are split: the li<span class="x">ght</span>house, and the <span class="b">wi</span><span class="b">nd</span>.</p>
<p>A comment<!-- hidden note --> sits here, and so does a soft&#173;hyphen.</p>
<p>Page break inside<span epub:type="pagebreak" id="page12" title="12"/> the text.</p>
<p><img src="../images/star.png" alt="A five-pointed star"/></p>
<p>* * *</p>
<blockquote><p>A quoted line in a blockquote.</p></blockquote>
<ul><li>First item<ul><li>Nested item</li></ul></li><li>Second item</li></ul>
<div class="poem" style="white-space: pre-wrap">The sea is wide,
the night is long.</div>
<p>Water<br/>and salt<br/>and wind.</p>
<p>See the <a href="ch2.xhtml#start">next chapter</a> for more.</p>
<p>She was the 19<sup>th</sup> keeper.</p>
</section>`;

export const CHAPTER_TWO = `<section epub:type="chapter">
<h1 id="start">Chapter Two</h1>
<a href="ch1.xhtml"><p>A link that wraps a whole paragraph.</p></a>
<span class="wrapper"><p>Paragraph one inside a span.</p><p>Paragraph two inside a span.</p></span>
<div>Text directly in a div, <em>with emphasis</em>.<p>And a paragraph inside the same div.</p>Then more text.</div>
<p id="mid">The storm came at midnight.</p>
<h2 id="part2">Second Scene</h2>
<p>The morning was quiet.</p>
</section>`;

export const NOTES = `<section epub:type="endnotes">
<h1>Notes</h1>
<aside epub:type="endnote" id="n1"><p>The ship names are invented.</p></aside>
</section>`;

/** A "human translation" of the sample novel into Polish (also invented for tests). */
export function sampleNovelTranslation(): Uint8Array {
  return buildFixtureEpub({
    language: "pl",
    title: "Latarniczka",
    identifier: "urn:uuid:aaaaaaaa-1234-4234-8234-123456789abc",
    docs: [
      {
        path: "text/okladka.xhtml",
        title: "Okładka",
        body: `<div class="cover"><img src="../images/cover.png" alt="cover.png"/></div>`,
      },
      {
        path: "text/r1.xhtml",
        title: "Rozdział pierwszy",
        body: `<h1>Rozdział pierwszy<br/><span class="sub">Lampa</span></h1>
<p>Mira co wieczór wspinała się po stu stopniach latarni, licząc je pod nosem.</p>
<p>Prowadziła mały notes, a w nim zapisywała nazwy przepływających statków: <i>Szara Czapla</i>, <i>Poranny Dzwon</i>.</p>
<p>Kot latarnika nazywał się Pieprz — nikt nie pamiętał dlaczego.</p>
<p>Morze jest szerokie,<br/>noc jest długa.</p>
<p>Była dziewiętnastą latarniczką.</p>`,
      },
      {
        path: "text/r2.xhtml",
        title: "Rozdział drugi",
        body: `<h1>Rozdział drugi</h1>
<p>Sztorm przyszedł o północy.</p>
<h2>Druga scena</h2>
<p>Poranek był cichy.</p>`,
      },
    ],
    toc: [
      { title: "Rozdział pierwszy", href: "text/r1.xhtml" },
      {
        title: "Rozdział drugi",
        href: "text/r2.xhtml",
        children: [{ title: "Druga scena", href: "text/r2.xhtml" }],
      },
    ],
  });
}

export function sampleNovel(version: "2.0" | "3.0" = "3.0"): Uint8Array {
  return buildFixtureEpub({
    version,
    docs: [
      {
        path: "text/cover.xhtml",
        title: "Cover",
        body: `<div class="cover"><img src="../images/cover.png" alt="cover.png"/></div>`,
      },
      { path: "text/ch1.xhtml", title: "Chapter One", body: CHAPTER_ONE },
      { path: "text/ch2.xhtml", title: "Chapter Two", body: CHAPTER_TWO },
      { path: "text/notes.xhtml", title: "Notes", body: NOTES, linear: false },
    ],
    toc: [
      { title: "Chapter One", href: "text/ch1.xhtml" },
      {
        title: "Chapter Two",
        href: "text/ch2.xhtml#start",
        children: [{ title: "Second Scene", href: "text/ch2.xhtml#part2" }],
      },
      { title: "Notes", href: "text/notes.xhtml" },
    ],
  });
}

/**
 * A small German book: front and back matter with German titles, names that
 * change form ("des Ordens", "Annas", "zum Schwarzen Turm"), Sie and du, and
 * German quotation marks.
 */
export function sampleGermanNovel(): Uint8Array {
  return buildFixtureEpub({
    language: "de",
    title: "Der Schwarze Turm",
    identifier: "urn:uuid:bbbbbbbb-1234-4234-8234-123456789abc",
    docs: [
      {
        path: "text/inhalt.xhtml",
        title: "Inhaltsverzeichnis",
        body: `<h1>Inhaltsverzeichnis</h1>
<p>Erstes Kapitel</p>
<p>Zweites Kapitel</p>`,
      },
      {
        path: "text/k1.xhtml",
        title: "Erstes Kapitel",
        body: `<h1>Erstes Kapitel</h1>
<p>Anna wartete am Tor des Schwarzen Turms, bis die Ritter des Ordens zurückkehrten.</p>
<p>„Kommen Sie herein“, sagte der Kapitän zu ihr, „der Orden erwartet Sie schon.“</p>
<p>Annas Bruder Jonas stand hinter ihm und schwieg.</p>
<p>Seit dem Winter war niemand mehr zum Schwarzen Turm hinaufgestiegen.</p>`,
      },
      {
        path: "text/k2.xhtml",
        title: "Zweites Kapitel",
        body: `<h1>Zweites Kapitel</h1>
<p>„Du hast es also gefunden“, flüsterte Jonas, als sie allein waren.</p>
<p>Anna nickte und zeigte ihm das Siegel des Ordens.</p>
<p>Der Kapitän durfte davon nichts erfahren.</p>`,
      },
      {
        path: "text/dank.xhtml",
        title: "Danksagung",
        body: `<h1>Danksagung</h1>
<p>Ich danke allen, die dieses Buch möglich gemacht haben.</p>`,
      },
    ],
    toc: [
      { title: "Inhaltsverzeichnis", href: "text/inhalt.xhtml" },
      { title: "Erstes Kapitel", href: "text/k1.xhtml" },
      { title: "Zweites Kapitel", href: "text/k2.xhtml" },
      { title: "Danksagung", href: "text/dank.xhtml" },
    ],
  });
}

/**
 * A small Russian book: front and back matter with Russian titles, names that
 * change form ("Ордена", "Анны", "Петру", "у Чёрной башни"), ты and вы, and
 * «» quotation marks.
 */
export function sampleRussianNovel(): Uint8Array {
  return buildFixtureEpub({
    language: "ru",
    title: "Чёрная башня",
    identifier: "urn:uuid:cccccccc-1234-4234-8234-123456789abc",
    docs: [
      {
        path: "text/soderzhanie.xhtml",
        title: "Содержание",
        body: `<h1>Содержание</h1>
<p>Глава первая</p>
<p>Глава вторая</p>`,
      },
      {
        path: "text/g1.xhtml",
        title: "Глава первая",
        body: `<h1>Глава первая</h1>
<p>Анна ждала у ворот Чёрной башни, пока рыцари Ордена не вернулись.</p>
<p>«Входите, — сказал ей капитан, — Орден уже ждёт вас».</p>
<p>Брат Анны, Пётр, стоял за ним и молчал.</p>
<p>С зимы никто не поднимался к Чёрной башне.</p>`,
      },
      {
        path: "text/g2.xhtml",
        title: "Глава вторая",
        body: `<h1>Глава вторая</h1>
<p>«Значит, ты её нашла», — прошептал Пётр, когда они остались одни.</p>
<p>Анна кивнула и показала Петру печать Ордена.</p>
<p>Капитан не должен был ничего об этом узнать.</p>`,
      },
      {
        path: "text/blagodarnosti.xhtml",
        title: "Благодарности",
        body: `<h1>Благодарности</h1>
<p>Спасибо всем, кто помог этой книге появиться.</p>`,
      },
    ],
    toc: [
      { title: "Содержание", href: "text/soderzhanie.xhtml" },
      { title: "Глава первая", href: "text/g1.xhtml" },
      { title: "Глава вторая", href: "text/g2.xhtml" },
      { title: "Благодарности", href: "text/blagodarnosti.xhtml" },
    ],
  });
}
