import type { AccountId, AccountState, DeviceId } from "@cerium/protocol";
import { REMOTE_UPDATES_RPC_VERSION, type RemoteUpdates } from "@cerium/rpc";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { accountAtom } from "../src/backend/atoms.ts";
import { connectionAtom } from "../src/backend/client.ts";
import { machineAtom } from "../src/backend/machine.ts";
import { RemoteUpdateSettings, remoteUpdatesAtom } from "../src/features/settings/RemoteUpdateSettings.tsx";

const machine = { id: "host" as DeviceId, name: "Build host" };

function render(status: RemoteUpdates["status"], headless = true, manual = status.kind === "unsupported") {
  const updates: RemoteUpdates = {
    channel: "stable",
    buildChannel: "stable",
    version: "1.0.0",
    manual,
    autoDownload: false,
    restart: "idle",
    status,
  };
  const account: AccountState = {
    _tag: "SignedIn",
    account: { id: "user" as AccountId },
    deviceId: "browser" as DeviceId,
    connection: "online",
    devices: [
      {
        ...machine,
        kind: "desktop",
        headless,
        platform: "linux",
        channel: "stable",
        version: updates.version,
        rpcVersion: REMOTE_UPDATES_RPC_VERSION,
        online: true,
        createdAt: 0,
      },
    ],
  };
  const registry = AtomRegistry.make({
    initialValues: [
      Atom.initialValue(accountAtom, AsyncResult.success(account)),
      Atom.initialValue(machineAtom, machine),
      Atom.initialValue(connectionAtom, "connected"),
      Atom.initialValue(remoteUpdatesAtom(machine.id), AsyncResult.success(updates)),
    ],
  });
  try {
    return renderToStaticMarkup(
      createElement(RegistryContext, { value: registry }, createElement(RemoteUpdateSettings, { machine })),
    );
  } finally {
    registry.dispose();
  }
}

describe("remote update settings", () => {
  it("offers checking and restarting a standalone host from Settings", () => {
    expect(render({ kind: "current", checkedAt: 1 })).toContain("Check now");
    expect(render({ kind: "available", version: "1.1.0" })).toContain("Update and restart");
  });

  it("offers terminal guidance when a headless host reports no remote updater", () => {
    const html = render({ kind: "unsupported" });
    expect(html).toContain("cerium-host update");
    expect(html).toContain("npm");
    expect(html).not.toContain("Update and restart");
    expect(render({ kind: "unsupported" }, false)).toContain("This installation needs to be updated on");
  });

  it("never shows Mac disk image instructions for manual updates on a headless host", () => {
    const html = render({ kind: "available", version: "1.1.0" }, true, true);
    expect(html).toContain("cerium-host update");
    expect(html).not.toContain("disk image");
  });
});
