import { describe, expect, it } from "vite-plus/test";

import { pushedRanges, touchesWorkflows } from "../pre-push.ts";

const sha = (digit: string) => digit.repeat(40);

describe("pre-push", () => {
  it("checks what each pushed ref adds, and nothing for a deleted one", () => {
    const input = [
      `refs/heads/main ${sha("a")} refs/heads/main ${sha("b")}`,
      `refs/heads/new ${sha("c")} refs/heads/new ${sha("0")}`,
      `(delete) ${sha("0")} refs/heads/old ${sha("d")}`,
      "",
    ].join("\n");
    expect(pushedRanges(input)).toEqual([
      { base: sha("b"), head: sha("a") },
      { base: sha("0"), head: sha("c") },
    ]);
    expect(pushedRanges("")).toEqual([]);
  });

  it("lints the workflows only when .github changes", () => {
    expect(touchesWorkflows(["apps/ui/src/app.tsx", ".github/workflows/ci.yml"])).toBe(true);
    expect(touchesWorkflows(["apps/ui/src/app.tsx", "docs/.github.md"])).toBe(false);
  });
});
