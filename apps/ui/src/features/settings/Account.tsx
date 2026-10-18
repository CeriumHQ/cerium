import { Button } from "@base-ui/react/button";
import { Switch } from "@base-ui/react/switch";
import { MAX_DEVICE_NAME, type AccountState, type DeviceId, type DeviceInfo } from "@cerium/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  Ellipsis,
  ExternalLink,
  LogIn,
  Monitor,
  MonitorSmartphone,
  Pencil,
  RefreshCw,
  Smartphone,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";

import {
  accountAtom,
  approveDevice,
  cancelSignIn,
  removeDevice,
  renameDevice,
  signIn,
  signOut,
} from "../../backend/atoms.ts";
import { shellBridge, type StartAtLogin } from "../../backend/shell.ts";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog.tsx";
import { MenuItem, MenuPopup, MenuRoot, MenuSeparator, MenuTrigger } from "../../components/ui/Menu.tsx";
import { deviceDetails, initials, isApproved, orderedDevices, presenceLabel } from "../account/model.ts";
import { TitleField } from "../threads/Rename.tsx";
import { SettingsCard, SettingsPage, SettingsSection } from "./parts.tsx";

type SignedIn = Extract<AccountState, { _tag: "SignedIn" }>;

const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "Something went wrong. Try again.";

export function AccountSettings() {
  const result = useAtomValue(accountAtom);
  const account = AsyncResult.isSuccess(result) ? result.value : undefined;

  return (
    <SettingsPage
      title="Account"
      description="Sign in to reach this computer from your phone and your other computers. It's optional: signed out, nothing leaves this computer."
    >
      <SettingsSection title="Cerium account">
        {account === undefined ? (
          <SettingsCard className="px-4 py-6 text-[13px] text-fg-tertiary">Checking…</SettingsCard>
        ) : account._tag === "SignedIn" ? (
          <AccountCard account={account} />
        ) : (
          <SignInCard account={account} />
        )}
      </SettingsSection>
      {account?._tag === "SignedIn" && isApproved(account) ? <DevicesSection account={account} /> : null}
      {account?._tag === "SignedIn" ? <ThisComputerSection /> : null}
    </SettingsPage>
  );
}

/** Signed out, or waiting on the browser: what signing in does, and the way to start it. */
function SignInCard({ account }: { account: Exclude<AccountState, SignedIn> }) {
  const start = useAtomSet(signIn, { mode: "promise" });
  const cancel = useAtomSet(cancelSignIn, { mode: "promise" });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();

  const begin = () => {
    setStarting(true);
    setError(undefined);
    void start({ payload: undefined }).then(
      ({ url }) => {
        setStarting(false);
        window.open(url, "_blank", "noopener,noreferrer");
      },
      (failure: unknown) => {
        setStarting(false);
        setError(messageOf(failure));
      },
    );
  };

  const shownError = error ?? (account._tag === "SignedOut" ? account.error : undefined);
  return (
    <SettingsCard className="flex gap-3.5 p-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line-subtle bg-surface-raised text-fg-secondary">
        <MonitorSmartphone size={17} strokeWidth={1.75} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-[13.5px] font-medium text-fg-primary">Connect this computer</span>
          <p className="text-[12.5px] leading-relaxed text-fg-tertiary">
            You'll sign in on Cerium's page in your browser, with Google, Discord, GitHub or an email and
            password. Cerium never sees your password.
          </p>
        </div>
        {account._tag === "SigningIn" ? (
          <Progress url={account.url} onCancel={() => void cancel({ payload: undefined })}>
            Finish signing in using your browser.
          </Progress>
        ) : (
          <div className="flex items-center gap-3">
            <Button
              onClick={begin}
              disabled={starting}
              className="flex h-8 w-fit shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12.5px] font-medium text-accent-fg transition-opacity hover:opacity-90 active:opacity-80 disabled:opacity-60"
            >
              <LogIn size={13} strokeWidth={2} />
              {starting ? "Opening your browser…" : "Sign in"}
            </Button>
            {shownError ? <p className="min-w-0 flex-1 text-[12.5px] text-error">{shownError}</p> : null}
          </div>
        )}
      </div>
    </SettingsCard>
  );
}

/** Waiting on the browser, with the page one click away again. */
function Progress({ url, onCancel, children }: { url: string; onCancel: () => void; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line-subtle bg-surface-window py-1.5 pr-1.5 pl-3 text-[12.5px]">
      <RefreshCw size={13} strokeWidth={1.75} className="shrink-0 animate-spin text-fg-tertiary" />
      <p className="min-w-0 flex-1 text-fg-secondary">{children}</p>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
      >
        <ExternalLink size={12} strokeWidth={1.75} />
        Open it again
      </a>
      <QuietButton onClick={onCancel}>Cancel</QuietButton>
    </div>
  );
}

const connectionLabel: Record<SignedIn["connection"], string> = {
  online: "Connected",
  connecting: "Connecting…",
  offline: "Can't reach Cerium's cloud",
};

/** Who this computer is signed in as, how it's connected, and signing out. */
function AccountCard({ account }: { account: SignedIn }) {
  const leave = useAtomSet(signOut, { mode: "promise" });
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const { name, email, imageUrl } = account.account;
  const approved = isApproved(account);

  return (
    <SettingsCard className="flex flex-col">
      <div className="flex items-center gap-3.5 p-4">
        <Avatar name={name} email={email} imageUrl={imageUrl} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13.5px] font-medium text-fg-primary">
            {name ?? email ?? "Your account"}
          </span>
          {name !== undefined && email !== undefined ? (
            <span className="truncate text-[12.5px] text-fg-tertiary">{email}</span>
          ) : null}
        </div>
        <ConnectionState connection={account.connection} />
        <QuietButton onClick={() => setConfirming(true)}>Sign out</QuietButton>
      </div>
      {account.connection === "online" && !approved ? (
        <p className="border-t border-line-subtle px-4 py-3 text-[12.5px] leading-relaxed text-attention">
          Waiting for approval. Allow this computer from a device that's already connected to your account;
          until then it sees nothing, and nothing can reach it.
        </p>
      ) : null}
      {error ? (
        <p className="border-t border-line-subtle px-4 py-3 text-[12.5px] text-error">{error}</p>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Sign out of Cerium?"
        description="This computer leaves your account: your other devices won't see it or reach it until you sign in again. Its threads stay here."
        confirmLabel="Sign out"
        onConfirm={() => {
          setError(undefined);
          void leave({ payload: undefined }).catch((failure: unknown) => setError(messageOf(failure)));
        }}
      />
    </SettingsCard>
  );
}

function Avatar({
  name,
  email,
  imageUrl,
}: {
  name: string | undefined;
  email: string | undefined;
  imageUrl: string | undefined;
}) {
  const [broken, setBroken] = useState(false);
  return imageUrl !== undefined && !broken ? (
    <img
      src={imageUrl}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className="size-9 shrink-0 rounded-full border border-line-subtle object-cover"
    />
  ) : (
    <span className="grid size-9 shrink-0 place-items-center rounded-full border border-line-subtle bg-surface-raised text-[12.5px] font-medium text-fg-secondary">
      {initials(name, email)}
    </span>
  );
}

function ConnectionState({ connection }: { connection: SignedIn["connection"] }) {
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 text-xs ${
        connection === "offline" ? "text-attention" : "text-fg-tertiary"
      }`}
    >
      <span
        className={`size-1.5 rounded-full ${
          connection === "online"
            ? "bg-success"
            : connection === "offline"
              ? "bg-attention"
              : "animate-pulse border border-fg-tertiary"
        }`}
      />
      {connectionLabel[connection]}
    </span>
  );
}

function QuietButton({
  onClick,
  disabled = false,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      onClick={onClick}
      disabled={disabled}
      className="flex h-7 shrink-0 items-center rounded-md px-2 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </Button>
  );
}

/** Every device of the account, with what an approved device may do to each. */
function DevicesSection({ account }: { account: SignedIn }) {
  // Offline, the list is the last one the relay sent: who's online is unknown, and nothing can change.
  const live = account.connection === "online";
  return (
    <SettingsSection
      title="Devices"
      description={
        live
          ? "Everything connected to your account. A new one waits, seeing nothing, until you allow it here or on another device that's already connected."
          : "Your devices as this computer last saw them. They update when it reaches Cerium's cloud again."
      }
    >
      <ul className="divide-y divide-line-subtle rounded-xl border border-line-subtle">
        {orderedDevices(account).map((device) => (
          <li key={device.id}>
            <DeviceRow device={device} self={device.id === account.deviceId} live={live} />
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}

function DeviceRow({ device, self, live }: { device: DeviceInfo; self: boolean; live: boolean }) {
  const approve = useAtomSet(approveDevice, { mode: "promise" });
  const rename = useAtomSet(renameDevice, { mode: "promise" });
  const remove = useAtomSet(removeDevice, { mode: "promise" });
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const deviceId = device.id as DeviceId;
  const Icon = device.kind === "browser" ? Smartphone : Monitor;

  const run = (action: Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    void action.then(
      () => setBusy(false),
      (failure: unknown) => {
        setBusy(false);
        setError(messageOf(failure));
      },
    );
  };

  const saveName = (typed: string) => {
    setEditing(false);
    const name = typed.trim().slice(0, MAX_DEVICE_NAME).trim();
    if (name === "" || name === device.name) return;
    run(rename({ payload: { deviceId, name } }));
  };

  return (
    <div className="flex flex-col gap-1.5 py-3 pr-3 pl-4">
      <div className="flex items-center gap-3.5">
        <span className="relative grid size-8 shrink-0 place-items-center rounded-lg border border-line-subtle bg-surface-raised text-fg-secondary">
          <Icon size={15} strokeWidth={1.75} />
          {live && device.online ? (
            <span
              aria-hidden
              className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-surface-panel bg-success"
            />
          ) : null}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            {editing ? (
              <TitleField
                title={device.name}
                maxLength={MAX_DEVICE_NAME}
                label="Device name"
                onDone={(typed) => (typed === undefined ? setEditing(false) : saveName(typed))}
                className="h-6 flex-1 text-[13px] font-medium"
              />
            ) : (
              <span className="truncate text-[13px] font-medium text-fg-primary" title={device.name}>
                {device.name}
              </span>
            )}
            {self && !editing ? (
              <span className="shrink-0 rounded-full border border-line-subtle px-1.5 text-2xs leading-4 text-fg-tertiary">
                This computer
              </span>
            ) : null}
          </div>
          <span className="truncate text-xs text-fg-tertiary">
            {deviceDetails(device)}
            {self || !live ? null : device.approved ? (
              <> · {presenceLabel(device)}</>
            ) : (
              <>
                {" · "}
                <span className="text-attention">Wants to join</span>
              </>
            )}
          </span>
        </div>
        {!device.approved ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <QuietButton onClick={() => run(remove({ payload: { deviceId } }))} disabled={busy || !live}>
              Deny
            </QuietButton>
            <Button
              onClick={() => run(approve({ payload: { deviceId } }))}
              disabled={busy || !live}
              className="flex h-7 items-center rounded-md bg-accent px-2.5 text-[12.5px] font-medium text-accent-fg transition-opacity hover:opacity-90 active:opacity-80 disabled:opacity-60"
            >
              Allow
            </Button>
          </div>
        ) : (
          <MenuRoot>
            <MenuTrigger>
              <Button
                aria-label={`More for ${device.name}`}
                className="grid size-7 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-secondary data-popup-open:bg-surface-hover data-popup-open:text-fg-secondary"
              >
                <Ellipsis size={15} strokeWidth={1.75} />
              </Button>
            </MenuTrigger>
            <MenuPopup>
              <MenuItem icon={Pencil} onClick={() => setEditing(true)} disabled={!live}>
                Rename…
              </MenuItem>
              <MenuSeparator />
              {/* Signing out works offline too: this computer forgets its sign-in either way. */}
              <MenuItem
                icon={Trash2}
                tone="danger"
                onClick={() => setRemoving(true)}
                disabled={!live && !self}
              >
                {self ? "Sign out…" : "Remove…"}
              </MenuItem>
            </MenuPopup>
          </MenuRoot>
        )}
      </div>
      {error ? <p className="pl-11.5 text-[12.5px] text-error">{error}</p> : null}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={self ? "Sign out of Cerium?" : `Remove ${device.name}?`}
        description={
          self
            ? "This computer leaves your account: your other devices won't see it or reach it until you sign in again. Its threads stay here."
            : `${device.name} leaves your account and is signed out. To come back, it signs in again and waits for you to allow it.`
        }
        confirmLabel={self ? "Sign out" : "Remove"}
        onConfirm={() => run(remove({ payload: { deviceId } }))}
      />
    </div>
  );
}

/** What keeps this computer reachable: the tray, and starting with Windows. */
function ThisComputerSection() {
  const bridge = shellBridge();
  const [startAtLogin, setStartAtLogin] = useState<StartAtLogin>();
  const [error, setError] = useState<string>();
  const labelId = useId();

  useEffect(() => {
    void bridge?.startAtLogin?.().then(setStartAtLogin, () => undefined);
  }, [bridge]);

  const change = (enabled: boolean) => {
    setError(undefined);
    setStartAtLogin((current) => current && { ...current, enabled });
    void bridge?.setStartAtLogin?.(enabled).then(setStartAtLogin, () => {
      setStartAtLogin((current) => current && { ...current, enabled: !enabled });
      setError("Windows didn't take that change. Try again.");
    });
  };

  return (
    <SettingsSection
      title="This computer"
      description="While you're signed in, closing Cerium's window keeps it running in the tray, so your other devices can still reach this computer. Agents at work keep it from going to sleep."
    >
      {bridge?.startAtLogin ? (
        <SettingsCard className="flex items-start gap-4 p-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span id={labelId} className="text-[13px] font-medium text-fg-primary">
              Start with Windows
            </span>
            <p className="text-[12.5px] leading-relaxed text-fg-tertiary">
              {startAtLogin?.available === false
                ? "Only the installed app can start with Windows."
                : "Opens straight to the tray when you sign in to Windows, so this computer is reachable after a restart."}
            </p>
            {error ? <p className="text-[12.5px] text-error">{error}</p> : null}
          </div>
          <Switch.Root
            checked={startAtLogin?.enabled ?? false}
            onCheckedChange={change}
            disabled={startAtLogin?.available !== true}
            aria-labelledby={labelId}
            className="relative mt-0.5 flex h-5 w-9 shrink-0 rounded-full bg-line-strong p-0.5 transition-colors duration-200 ease-out-soft outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-panel data-checked:bg-accent data-disabled:opacity-40"
          >
            <Switch.Thumb className="size-4 rounded-full bg-fg-primary shadow-raised transition-[translate,background-color] duration-200 ease-out-soft data-checked:translate-x-4 data-checked:bg-accent-fg" />
          </Switch.Root>
        </SettingsCard>
      ) : null}
    </SettingsSection>
  );
}
