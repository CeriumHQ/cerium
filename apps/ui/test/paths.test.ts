import { describe, expect, it } from "@effect/vitest";

import { pathReference } from "../src/features/transcript/paths.ts";

describe("pathReference", () => {
  it("recognises files by their extension or name", () => {
    expect(pathReference("CONTRIBUTING.md")).toEqual({ path: "CONTRIBUTING.md", folder: false });
    expect(pathReference("scripts/check-commits.ts")).toEqual({
      path: "scripts/check-commits.ts",
      folder: false,
    });
    expect(pathReference("skills-lock.json")).toEqual({ path: "skills-lock.json", folder: false });
    expect(pathReference("apply-admin-widgets.ps1")).toEqual({
      path: "apply-admin-widgets.ps1",
      folder: false,
    });
    expect(pathReference(".gitignore")).toEqual({ path: ".gitignore", folder: false });
    expect(pathReference("Dockerfile")).toEqual({ path: "Dockerfile", folder: false });
  });

  it("recognises folders by their trailing separator", () => {
    expect(pathReference(".agents/")).toEqual({ path: ".agents", folder: true });
    expect(pathReference("docs/")).toEqual({ path: "docs", folder: true });
    expect(pathReference("apps\\ui\\")).toEqual({ path: "apps\\ui", folder: true });
  });

  it("keeps a line number apart from the path", () => {
    expect(pathReference("apps/ui/src/App.tsx:42")).toEqual({
      path: "apps/ui/src/App.tsx",
      folder: false,
      line: 42,
    });
    expect(pathReference("src/main.rs#L10-L20")).toEqual({ path: "src/main.rs", folder: false, line: 10 });
  });

  it("accepts deep or rooted paths without an extension", () => {
    expect(pathReference("packages/adapters/claude")).toEqual({
      path: "packages/adapters/claude",
      folder: true,
    });
    expect(pathReference("C:\\Users\\me\\bin\\tool")).toEqual({
      path: "C:\\Users\\me\\bin\\tool",
      folder: true,
    });
  });

  it("leaves code that only looks like a path alone", () => {
    const codes = [
      "Effect.gen",
      "react-dom/client",
      "@cerium/protocol",
      "scripts/_*",
      "font-size-adjust",
      "session.close()",
      "https://example.com/a.ts",
      "--data-dir=.cerium",
      "a / b",
      "and/or",
      "v1.2.3",
      "/",
    ];
    expect(codes.filter((code) => pathReference(code) !== undefined)).toEqual([]);
  });
});
