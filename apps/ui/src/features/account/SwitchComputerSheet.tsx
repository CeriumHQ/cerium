import type { AccountState } from "@cerium/protocol";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Monitor } from "lucide-react";
import { useContext } from "react";

import { driveMachine, machineAtom } from "../../backend/machine.ts";
import { WEB } from "../../backend/target.ts";
import { Sheet, SheetRow } from "../../components/ui/Sheet.tsx";
import { platformLabel, thisDevice, whyUnreachable } from "./model.ts";

/**
 * The compact window's way to drive another of the account's computers, from the Thread sheet's
 * Connection card: the same choice as the machine picker, as a bottom sheet. One that can't be
 * reached says why and can't be picked.
 */
export function SwitchComputerSheet({
  open,
  onOpenChange,
  account,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: AccountState;
}) {
  const registry = useContext(RegistryContext);
  const driven = useAtomValue(machineAtom);
  if (account._tag !== "SignedIn") return null;
  const self = WEB ? undefined : thisDevice(account);
  const others = account.devices.filter(
    (device) => device.kind === "desktop" && device.id !== account.deviceId,
  );
  const driving = driven?.id ?? (WEB ? undefined : account.deviceId);
  const rows = [
    ...(self
      ? [{ device: self, detail: `This computer · ${platformLabel(self.platform)}`, reason: undefined }]
      : []),
    ...others.map((device) => {
      const reason = whyUnreachable(device);
      return { device, detail: reason ?? platformLabel(device.platform), reason };
    }),
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Switch computer">
      <ul className="flex flex-col pb-1">
        {rows.map(({ device, detail, reason }) => {
          const current = device.id === driving;
          return (
            <li key={device.id}>
              <SheetRow
                aria-current={current ? "true" : undefined}
                disabled={!current && reason !== undefined}
                onClick={() => {
                  onOpenChange(false);
                  if (current) return;
                  driveMachine(
                    registry,
                    device.id === account.deviceId ? undefined : { id: device.id, name: device.name },
                  );
                }}
                icon={<Monitor size={16} strokeWidth={1.75} />}
                trailing={current ? <span className="text-meta text-fg-secondary">Current</span> : undefined}
                className="h-14"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{device.name}</span>
                    {reason === undefined && device.id !== account.deviceId ? (
                      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
                    ) : null}
                  </span>
                  <span
                    className={`truncate text-meta ${reason !== undefined && device.online ? "text-attention-text" : "text-fg-tertiary"}`}
                  >
                    {detail}
                  </span>
                </span>
              </SheetRow>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
