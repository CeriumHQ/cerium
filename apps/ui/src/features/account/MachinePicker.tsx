import { Button } from "@base-ui/react/button";
import { Menu } from "@base-ui/react/menu";
import type { AccountState, DeviceInfo } from "@cerium/protocol";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Check, ChevronDown } from "lucide-react";
import { useContext } from "react";

import { driveMachine, machineAtom } from "../../backend/machine.ts";
import type { ShownStatus } from "../../app/connectionStatus.ts";
import { menuPopupClass } from "../../components/ui/Menu.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { WEB } from "../../backend/target.ts";
import { DeviceIcon } from "./DeviceIcon.tsx";
import { machinePlatform, thisDevice, whyUnreachable } from "./model.ts";

/**
 * Chooses which of the account's computers the window drives: this one, or
 * another that's online, whose threads, projects and harnesses then fill the window. Shown once the
 * account has more than one computer. The web client, which has no computer of its own,
 * always drives one of them.
 */
export function MachinePicker({
  account,
  status,
}: {
  account: AccountState;
  /** How the line to the driven computer stands: a degraded one marks the compact trigger. */
  status?: ShownStatus | undefined;
}) {
  const registry = useContext(RegistryContext);
  const driven = useAtomValue(machineAtom);
  if (account._tag !== "SignedIn") return null;
  const self = thisDevice(account);
  const others = account.devices.filter(
    (device) => device.kind === "desktop" && device.id !== account.deviceId,
  );
  if (others.length === 0 && (driven === undefined || WEB)) return null;
  const label = driven?.name ?? (WEB ? "Choose a computer" : (self?.name ?? "This computer"));
  // Driving another computer from one's own window stands out; the web client always drives one.
  const elsewhere = driven !== undefined && !WEB;
  const driving = driven?.id ?? (WEB ? "" : account.deviceId);
  // Driving this computer is the usual case, so the wide window's titlebar shows the icon alone; the tooltip names it.
  const quiet = !WEB && driven === undefined;
  const away = status?.kind === "reconnecting" || status?.kind === "offline" ? status.kind : undefined;

  const selected = account.devices.find((device) => device.id === driving);

  const choose = (id: string) => {
    if (id === account.deviceId) return driveMachine(registry, undefined);
    const device = others.find((other) => other.id === id);
    if (device !== undefined && whyUnreachable(device) === undefined) {
      driveMachine(registry, { id: device.id, name: device.name });
    }
  };

  return (
    <Menu.Root>
      <Tooltip label={`Working on ${label}`}>
        <Menu.Trigger
          render={
            <Button
              aria-label={`Computer: ${label}${away === "reconnecting" ? ", reconnecting" : away === "offline" ? ", offline" : ""}`}
              className={`relative flex h-6 max-w-48 min-w-0 items-center gap-1.5 rounded-md border px-1.5 text-meta transition-colors duration-150 select-none [app-region:no-drag] data-popup-open:bg-surface-active max-md:h-9 max-md:max-w-44 max-md:rounded-lg max-md:px-2.5 max-md:text-[14px] ${
                // Alone, it takes the size of the icon buttons beside it.
                quiet ? "md:size-7 md:justify-center md:px-0" : ""
              } ${
                // Driving another computer gets a visible edge, so the window never looks like this one by mistake.
                elsewhere
                  ? "border-line-strong bg-surface-raised font-medium text-fg-primary hover:bg-surface-hover"
                  : "border-transparent text-fg-tertiary hover:bg-surface-hover hover:text-fg-secondary"
              }`}
            />
          }
        >
          <DeviceIcon
            device={selected}
            size={13}
            strokeWidth={1.75}
            className={`shrink-0 ${quiet ? "md:size-[15px]" : ""}`}
          />
          <span className={`truncate ${quiet ? "md:hidden" : ""}`}>{label}</span>
          <ChevronDown
            size={12}
            strokeWidth={2}
            className={`shrink-0 opacity-70 ${quiet ? "md:hidden" : ""}`}
          />
          {away ? (
            <span
              aria-hidden
              className={`absolute top-1.5 right-1.5 size-1.5 rounded-full ring-2 ring-[var(--surface-window)] md:hidden ${
                away === "reconnecting"
                  ? "animate-[pulse_1.6s_ease-in-out_infinite] bg-attention motion-reduce:animate-none"
                  : "border border-fg-disabled bg-[var(--surface-window)]"
              }`}
            />
          ) : null}
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50 outline-none">
          <Menu.Popup className={`${menuPopupClass} w-64`}>
            <Menu.Group>
              <Menu.GroupLabel className="px-2 pt-1.5 pb-1 text-caption font-medium text-fg-tertiary select-none">
                Work on
              </Menu.GroupLabel>
              <Menu.RadioGroup value={driving} onValueChange={(id: string) => choose(id)}>
                {self && !WEB ? (
                  <MachineItem device={self} detail={`This computer · ${machinePlatform(self)}`} />
                ) : null}
                {others.map((device) => {
                  const reason = whyUnreachable(device);
                  // The machine being driven stays selectable, so its check mark shows even while it's away.
                  return (
                    <MachineItem
                      key={device.id}
                      device={device}
                      detail={reason ?? machinePlatform(device)}
                      reachable={reason === undefined}
                      attention={reason !== undefined && device.online}
                      disabled={reason !== undefined && device.id !== driven?.id}
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
  device,
  detail,
  reachable = false,
  attention = false,
  disabled = false,
}: {
  device: DeviceInfo;
  detail: string;
  /** Shows the green dot: it can be driven now. */
  reachable?: boolean;
  /** Its detail says what to do about it, so it reads as a warning. */
  attention?: boolean;
  disabled?: boolean;
}) {
  return (
    <Menu.RadioItem
      value={device.id}
      disabled={disabled}
      closeOnClick
      className="group relative flex cursor-default items-center gap-2.5 rounded-lg py-1.5 pr-8 pl-2 outline-none select-none data-highlighted:bg-surface-hover"
    >
      {/* Dimmed when it can't be chosen; its detail stays readable, since that says why. */}
      <DeviceIcon
        device={device}
        size={15}
        strokeWidth={1.75}
        className="shrink-0 text-fg-tertiary group-data-disabled:opacity-40"
      />
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-body text-fg-primary group-data-disabled:opacity-40">
            {device.name}
          </span>
          {reachable ? <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden /> : null}
        </span>
        <span className={`truncate text-caption ${attention ? "text-attention-text" : "text-fg-tertiary"}`}>
          {reachable ? <span className="sr-only">Online, </span> : null}
          {detail}
        </span>
      </span>
      <Menu.RadioItemIndicator className="absolute right-2.5 text-fg-secondary">
        <Check size={14} strokeWidth={2} />
      </Menu.RadioItemIndicator>
    </Menu.RadioItem>
  );
}
