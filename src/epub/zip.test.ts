import { describe, expect, it } from "vitest";
import { storeZip } from "../testing/epub-fixtures.ts";
import { readZip, writeEpubZip, ZipError } from "./zip.ts";

const enc = new TextEncoder();

describe("zip", () => {
  it("reads entries in order and decodes UTF-8 names without the UTF-8 flag", () => {
    const bytes = storeZip(
      [
        { name: "mimetype", data: enc.encode("application/epub+zip") },
        { name: "OEBPS/Rozdział 1.xhtml", data: enc.encode("<p/>") },
      ],
      { utf8Flag: false },
    );
    const entries = readZip(bytes);
    expect(entries.map((e) => e.name)).toEqual(["mimetype", "OEBPS/Rozdział 1.xhtml"]);
  });

  it("writes mimetype first, stored, with no extra field", () => {
    const bytes = writeEpubZip([
      { name: "OEBPS/a.xhtml", data: enc.encode("<p>hello hello hello</p>") },
      { name: "mimetype", data: enc.encode("ignored") },
    ]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0); // stored
    expect(view.getUint16(26, true)).toBe(8); // name length
    expect(view.getUint16(28, true)).toBe(0); // extra length
    expect(new TextDecoder().decode(bytes.subarray(30, 38))).toBe("mimetype");
    expect(new TextDecoder().decode(bytes.subarray(38, 58))).toBe("application/epub+zip");
    const back = readZip(bytes);
    expect(back.map((e) => e.name)).toEqual(["mimetype", "OEBPS/a.xhtml"]);
    expect(new TextDecoder().decode(back[1]!.data)).toBe("<p>hello hello hello</p>");
  });

  it("enforces size limits", () => {
    const bytes = storeZip([{ name: "big.txt", data: new Uint8Array(2000) }]);
    expect(() =>
      readZip(bytes, { maxEntries: 10, maxTotalUncompressed: 1000, maxEntryUncompressed: 5000 }),
    ).toThrow(ZipError);
  });

  it("rejects things that aren't ZIP files", () => {
    expect(() => readZip(enc.encode("not a zip at all, sorry"))).toThrow(ZipError);
  });
});
