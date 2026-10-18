import { Button } from "@base-ui/react/button";
import { Menu } from "@base-ui/react/menu";
import type { AccountState } from "@cerium/protocol";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Check, ChevronDown, Monitor } from "lucide-react";
import { useContext } from "react";

import { driveMachine, machineAtom } from "../../backend/machine.ts";
import { WEB } from "../../backend/target.ts";
import { isApproved, platformLabel, thisDevice, whyUnreachable } from "./model.ts";

/**
 * Chooses which of the account's computers the window drives (docs/architecture.md §14.8): this one,
 * or another that's online, whose threads, projects and harnesses then fill the window. Shown once
 * the account has more than one approved computer. The web client, which has no computer of its own,
 * always drives one of them (§14.10).
 */
export function MachinePicker({ account }: { account: AccountState }) {
  const registry = useContext(RegistryContext);
  const driven = useAtomValue(machineAtom);
  if (account._tag !== "SignedIn" || !isApproved(account)) return null;
  const self = thisDevice(account);
  const others = account.devices.filter(
    (device) => device.kind === "desktop" && device.approved && device.id !== account.deviceId,
  );
  if (others.length === 0 && (driven === undefined || WEB)) return null;
  const label = driven?.name ?? (WEB ? "Choose a computer" : (self?.name ?? "This computer"));
  // Driving another computer from one's own window stands out; the web client always drives one.
  const elsewhere = driven !== undefined && !WEB;

  const choose = (id: string) => {
    if (id === account.deviceId) return driveMachine(registry, undefined);
    const device = others.find((other) => other.id === id);
    if (device !== undefined && whyUnreachable(device) === undefined) {
      driveMachine(registry, { id: device.id, name: device.name });
    }
  };

  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            aria-label={`Computer: ${label}`}
            className={`flex h-6 max-w-48 items-center gap-1.5 rounded-md px-1.5 text-[12.5px] transition-colors duration-150 select-none [app-region:no-drag] data-popup-open:bg-surface-active max-md:h-9 max-md:max-w-44 max-md:rounded-lg max-md:px-2.5 max-md:text-[13.5px] ${
              elsewhere
                ? "bg-accent-soft font-medium text-fg-primary hover:bg-surface-active"
                : "text-fg-tertiary hover:bg-surface-hover hover:text-fg-secondary"
            }`}
          />
        }
      >
        <Monitor size={13} strokeWidth={1.75} className="shrink-0" />
        <span className="truncate">{label}</span>
        <ChevronDown size={12} strokeWidth={2} className="shrink-0 opacity-70" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50 outline-none">
          <Menu.Popup className="w-64 origin-(--transform-origin) rounded-xl border border-line-subtle bg-surface-overlay p-1 text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0">
            <Menu.Group>
              <Menu.GroupLabel className="px-2 pt-1.5 pb-1 text-2xs font-medium text-fg-tertiary select-none">
                Work on
              </Menu.GroupLabel>
              <Menu.RadioGroup
                value={driven?.id ?? (WEB ? "" : account.deviceId)}
                onValueChange={(id: string) => choose(id)}
              >
                {self && !WEB ? (
                  <MachineItem
                    value={self.id}
                    name={self.name}
                    detail={`This computer · ${platformLabel(self.platform)}`}
                  />
                ) : null}
                {others.map((device) => {
                  const reason = whyUnreachable(device);
                  return (
                    <MachineItem
                      key={device.id}
                      value={device.id}
                      name={device.name}
                      detail={reason ?? `Online · ${platformLabel(device.platform)}`}
                      online={device.online}
                      disabled={reason !== undefined}
                    />
                  );
                })}
              </Menu.RadioGroup>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function MachineItem({
  value,
  name,
  detail,
  online = true,
  disabled = false,
}: {
  value: string;
  name: string;
  detail: string;
  online?: boolean;
  disabled?: boolean;
}) {
  return (
    <Menu.RadioItem
      value={value}
      disabled={disabled}
      closeOnClick
      className="relative flex cursor-default items-center gap-2.5 rounded-lg py-1.5 pr-8 pl-2 outline-none select-none data-disabled:opacity-50 data-highlighted:bg-surface-hover"
    >
      <span className="relative grid size-7 shrink-0 place-items-center rounded-md border border-line-subtle bg-surface-raised text-fg-secondary">
        <Monitor size={13} strokeWidth={1.75} />
        {online ? (
          <span
            aria-hidden
            className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full border-[1.5px] border-surface-overlay bg-success"
          />
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] text-fg-primary">{name}</span>
        <span className="truncate text-2xs text-fg-tertiary">{detail}</span>
      </span>
      <Menu.RadioItemIndicator className="absolute right-2.5 text-fg-secondary">
        <Check size={14} strokeWidth={2} />
      </Menu.RadioItemIndicator>
    </Menu.RadioItem>
  );
}
