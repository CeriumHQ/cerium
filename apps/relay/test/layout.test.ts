import { describe, expect, it } from "@effect/vitest";

import { layOut, type WebBuild } from "../scripts/layout.ts";

const build = (version: string, policy = `script-src 'self' 'sha256-${version}'`): WebBuild => ({
  folder: `/builds/${version}`,
  version,
  pageHeaders: [`Content-Security-Policy: ${policy}`, "X-Content-Type-Options: nosniff"],
});

describe("the relay's web UI builds", () => {
  it("serves this checkout's build at the root and every build under its version", () => {
    const { builds, headers } = layOut(build("0.3.0"), [build("0.2.0"), build("0.3.0-nightly.4")], "");
    expect(builds.map((each) => each.version).toSorted()).toEqual(["0.2.0", "0.3.0", "0.3.0-nightly.4"]);
    const rules = headers.trimEnd().split("\n\n");
    expect(rules).toContain(
      "/\n  Content-Security-Policy: script-src 'self' 'sha256-0.3.0'\n  X-Content-Type-Options: nosniff",
    );
    expect(rules).toContain(
      "/v/0.2.0/index.html\n  Content-Security-Policy: script-src 'self' 'sha256-0.2.0'\n  X-Content-Type-Options: nosniff",
    );
    expect(rules).toContain("/sw.js\n  Cache-Control: no-cache");
    expect(rules).toContain("/v/builds.json\n  Cache-Control: no-cache");
  });

  it("gives each page only its own build's policy", () => {
    const { headers } = layOut(build("0.3.0"), [build("0.2.0")], "");
    for (const rule of headers.split("\n\n")) {
      expect(rule.match(/Content-Security-Policy/g)?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });

  it("prefers this checkout's build over an earlier one of its version", () => {
    const { builds } = layOut(build("0.3.0", "fresh"), [build("0.3.0", "stale")], "");
    expect(builds).toHaveLength(1);
    expect(builds[0]?.pageHeaders[0]).toBe("Content-Security-Policy: fresh");
  });

  it("keeps the relay's own rules", () => {
    const { headers } = layOut(build("0.3.0"), [], "/link\n  X-Frame-Options: DENY\n");
    expect(headers.trimEnd().endsWith("/link\n  X-Frame-Options: DENY")).toBe(true);
  });

  it("refuses more builds than Cloudflare reads rules for", () => {
    const many = Array.from({ length: 60 }, (_, index) => build(`0.1.${index}`));
    expect(() => layOut(build("0.3.0"), many, "")).toThrow(/header rules/);
  });
});
