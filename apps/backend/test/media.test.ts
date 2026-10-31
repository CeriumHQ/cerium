import { describe, expect, it } from "@effect/vitest";

import { byteRange } from "../src/media.ts";

describe("byteRange", () => {
  it("is the whole file without a header, or with one it can't read or several ranges", () => {
    expect(byteRange(undefined, 100)).toEqual({ _tag: "Whole" });
    expect(byteRange("items=0-1", 100)).toEqual({ _tag: "Whole" });
    expect(byteRange("bytes=0-1,5-6", 100)).toEqual({ _tag: "Whole" });
    expect(byteRange("bytes=-", 100)).toEqual({ _tag: "Whole" });
  });

  it("reads a start, an end, an open end and a suffix", () => {
    expect(byteRange("bytes=0-", 100)).toEqual({ _tag: "Part", start: 0, end: 99 });
    expect(byteRange("bytes=10-19", 100)).toEqual({ _tag: "Part", start: 10, end: 19 });
    expect(byteRange("bytes=90-500", 100)).toEqual({ _tag: "Part", start: 90, end: 99 });
    expect(byteRange("bytes=-30", 100)).toEqual({ _tag: "Part", start: 70, end: 99 });
    expect(byteRange("bytes=-300", 100)).toEqual({ _tag: "Part", start: 0, end: 99 });
  });

  it("can't serve a range past the end", () => {
    expect(byteRange("bytes=100-", 100)).toEqual({ _tag: "Unsatisfiable" });
    expect(byteRange("bytes=-0", 100)).toEqual({ _tag: "Unsatisfiable" });
    expect(byteRange("bytes=-1", 0)).toEqual({ _tag: "Unsatisfiable" });
    expect(byteRange("bytes=-300", 0)).toEqual({ _tag: "Unsatisfiable" });
  });
});
