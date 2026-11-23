import { describe, expect, it, vi } from "vite-plus/test";
import type { RemoteUpdates, UpdateCommand } from "@cerium/rpc";
import { remoteUpdates } from "../src/remoteUpdates.ts";
import type { AvailableRelease } from "../src/update.ts";

const release: AvailableRelease = {
  version: "1.1.0",
  platform: "linux-x64",
  asset: "cerium-host-1.1.0-linux-x64.tar.gz",
};
function fixture(root: string | undefined) {
  const states: RemoteUpdates[] = [];
  const check = vi.fn<() => Promise<AvailableRelease>>().mockResolvedValue(release);
  const activate = vi.fn<() => Promise<void>>().mockResolvedValue();
  const discard = vi.fn<() => Promise<void>>().mockResolvedValue();
  const prepare = vi
    .fn<() => Promise<{ activate: typeof activate; discard: typeof discard }>>()
    .mockResolvedValue({ activate, discard });
  const working = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
  const restart = vi.fn<() => void>();
  const host = remoteUpdates({
    version: "1.0.0",
    channel: "stable",
    root,
    send: (s) => states.push(s),
    check,
    prepare,
    working,
    restart,
  });
  return {
    request: (command: UpdateCommand | null) => host.receive({ type: "desktopUpdate", command }),
    close: () => host.close(),
    states,
    check,
    activate,
    discard,
    prepare,
    working,
    restart,
  };
}

describe("headless update supervisor", () => {
  it("returns a local-update-only state for npm and ignores remote actions", async () => {
    const host = fixture(undefined);
    await host.request(null);
    await host.request({ kind: "check" });
    await host.request({ kind: "apply", version: release.version });
    expect(host.states.at(-1)).toMatchObject({ manual: true, status: { kind: "unsupported" } });
    expect(host.check).not.toHaveBeenCalled();
    expect(host.prepare).not.toHaveBeenCalled();
  });

  it("only installs an offered version, and waits for agents to finish before switching", async () => {
    const host = fixture("/host");
    await host.request(null);
    expect(host.states.at(-1)?.status).toEqual({ kind: "available", version: release.version });
    await host.request({ kind: "apply", version: "9.9.9" });
    expect(host.prepare).not.toHaveBeenCalled();
    host.working.mockResolvedValueOnce(true);
    await host.request({ kind: "apply", version: release.version });
    expect(host.states.at(-1)).toMatchObject({ status: { kind: "ready" }, restart: "working" });
    expect(host.activate).not.toHaveBeenCalled();
    await host.request({ kind: "apply", version: release.version });
    expect(host.prepare).toHaveBeenCalledOnce();
    expect(host.activate).toHaveBeenCalledOnce();
    expect(host.restart).toHaveBeenCalledOnce();
  });

  it("reports a failed download, permits retries and discards queued files on shutdown", async () => {
    const host = fixture("/host");
    await host.request(null);
    host.prepare.mockRejectedValueOnce(new Error("checksum mismatch"));
    await host.request({ kind: "apply", version: release.version });
    expect(host.states.at(-1)?.status.kind).toBe("failed");
    expect(host.restart).not.toHaveBeenCalled();
    host.working.mockResolvedValueOnce(true);
    await host.request({ kind: "apply", version: release.version });
    await host.close();
    expect(host.discard).toHaveBeenCalledOnce();
    expect(host.restart).not.toHaveBeenCalled();
  });
});
