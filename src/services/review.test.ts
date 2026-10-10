import { describe, expect, it } from "vitest";
import { replaceInText } from "./review.ts";

describe("replacing text", () => {
  it("replaces between formatting tags and leaves the tags as they are", () => {
    expect(replaceInText("<g1>Bob</g1> met Bobby.", "bob", "Rob", { wholeWord: true })).toEqual({
      text: "<g1>Rob</g1> met Bobby.",
      count: 1,
      skipped: 0,
    });
  });

  it("skips a match that crosses a tag, rather than breaking the formatting", () => {
    expect(replaceInText("Hu<g1>gh</g1> said hugh.", "hugh", "Hubert", {})).toEqual({
      text: "Hu<g1>gh</g1> said Hubert.",
      count: 1,
      skipped: 1,
    });
  });
});
