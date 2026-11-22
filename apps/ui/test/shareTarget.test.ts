import { describe, expect, it } from "@effect/vitest";

import {
  readShared,
  sharedSegments,
  sharedText,
  takeShared,
  withoutShare,
} from "../src/features/composer/shareTarget.ts";

describe("readShared", () => {
  it("reads the share's fields, trimmed, and nothing when there are none", () => {
    expect(readShared("?share_title=%20Hi%20&share_text=&share_url=https%3A%2F%2Fa.dev")).toEqual({
      title: "Hi",
      url: "https://a.dev",
    });
    expect(readShared("?thread=1")).toBeUndefined();
  });
});

describe("sharedText", () => {
  it("puts title, text and link a blank line apart", () => {
    expect(sharedText({ title: "Bug", text: "It crashes", url: "https://a.dev/1" })).toBe(
      "Bug\n\nIt crashes\n\nhttps://a.dev/1",
    );
  });

  it("says each thing once", () => {
    expect(sharedText({ text: "Look https://a.dev/1", url: "https://a.dev/1" })).toBe("Look https://a.dev/1");
    expect(sharedText({ title: "Page", text: "Page" })).toBe("Page");
    expect(sharedText({ title: "https://a.dev", url: "https://a.dev" })).toBe("https://a.dev");
  });

  it("makes segments for a draft", () => {
    expect(sharedSegments({ text: "hi" })).toEqual([{ kind: "text", text: "hi" }]);
    expect(sharedSegments({})).toEqual([]);
  });
});

describe("takeShared", () => {
  it("cleans only the share from the address, once", () => {
    expect(withoutShare("https://x.dev/app/?share_text=hi&thread=2#end")).toBe("/app/?thread=2#end");
    const calls: Array<string> = [];
    const history = {
      state: { a: 1 },
      replaceState: (_: unknown, __: string, url?: string | URL | null) => void calls.push(String(url)),
    };
    const location = {
      href: "https://x.dev/app/?share_title=T&share_text=Body",
      search: "?share_title=T&share_text=Body",
    };
    expect(takeShared(location, history)).toBe("T\n\nBody");
    expect(calls).toEqual(["/app/"]);
    expect(takeShared({ href: "https://x.dev/app/", search: "" }, history)).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
