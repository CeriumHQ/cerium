import { Button } from "@base-ui/react/button";
import { MAX_DEVICE_NAME, type AccountState, type DeviceId, type DeviceInfo } from "@cerium/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  Ellipsis,
  ExternalLink,
  Globe,
  LogIn,
  Monitor,
  MonitorSmartphone,
  Pencil,
  RefreshCw,
  Smartphone,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  accountAtom,
  cancelSignIn,
  removeDevice,
  renameDevice,
  signIn,
  signOut,
} from "../../backend/atoms.ts";
import { openSignIn, signInHref } from "../../backend/signIn.ts";
import { WEB } from "../../backend/target.ts";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog.tsx";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/Menu.tsx";
import {
  deviceDetails,
  deviceVersion,
  initials,
  orderedDevices,
  presenceLabel,
  reachOf,
  selfNoun,
  thisDevice,
} from "../account/model.ts";
import { TitleField } from "../threads/Rename.tsx";
import { SettingsCard, SettingsNote, SettingsPage } from "./parts.tsx";

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
      title="Sign-in"
      description={
        WEB
          ? "Sign in to the same account here and on your computer to use its agents from this device."
          : account?._tag === "SignedIn"
            ? "Your other devices reach this computer through your account."
            : "Optional. Signed out, nothing leaves this computer."
      }
    >
      {account === undefined ? (
        <SettingsCard className="px-4 py-6 text-body text-fg-tertiary">Checking…</SettingsCard>
      ) : account._tag === "SignedIn" ? (
        <AccountCard account={account} />
      ) : (
        <SignInCard account={account} />
      )}
    </SettingsPage>
  );
}

/** Every device signed in to the account; signed out, the way to the sign-in. */
export function DeviceSettings({ onOpen }: { onOpen?: () => void }) {
  const result = useAtomValue(accountAtom);
  const account = AsyncResult.isSuccess(result) ? result.value : undefined;
  // Offline, the list is the last one the relay sent: who's online is unknown, and nothing can change.
  const live = account?._tag === "SignedIn" && account.connection === "online";
  return (
    <SettingsPage
      title="Devices"
      description={
        account?._tag !== "SignedIn"
          ? undefined
          : live
            ? "Everywhere you're signed in. To add a device, sign in to this account on it."
            : "As this computer last saw them. They update when it's back online."
      }
    >
      {account === undefined ? (
        <SettingsNote>Checking…</SettingsNote>
      ) : account._tag === "SignedIn" && thisDevice(account) !== undefined ? (
        <ul className="divide-y divide-line-subtle rounded-lg border border-line-subtle bg-surface-pane">
          {orderedDevices(account).map((device) => (
            <li key={device.id}>
              <DeviceRow device={device} self={device.id === account.deviceId} live={live} />
            </li>
          ))}
        </ul>
      ) : (
        <SettingsNote>
          Sign in to reach this {selfNoun} from your other devices.{" "}
          {onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              className="text-fg-secondary underline-offset-2 hover:underline"
            >
              Sign in
            </button>
          ) : null}
        </SettingsNote>
      )}
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
        openSignIn(url);
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
          <span className="text-reading font-medium text-fg-primary">Connect this {selfNoun}</span>
          <p className="text-meta leading-relaxed text-fg-tertiary">
            Reach it from your phone and your other computers, and get notified there when an agent needs you.
          </p>
        </div>
        {account._tag === "SigningIn" ? (
          <Progress url={account.url} onCancel={() => void cancel({ payload: undefined })}>
            {WEB ? "Finish signing in on Cerium's page." : "Finish signing in using your browser."}
          </Progress>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button
              onClick={begin}
              disabled={starting}
              className="flex h-8 w-fit shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-meta font-medium text-accent-fg transition-opacity hover:opacity-90 active:opacity-80 disabled:opacity-60"
            >
              <LogIn size={13} strokeWidth={2} />
              {starting ? "Opening your browser…" : "Sign in"}
            </Button>
            <p className="text-meta text-fg-tertiary">
              Google, GitHub, X or email. Cerium never sees your password.
            </p>
            {shownError ? <p className="w-full text-meta text-error-text">{shownError}</p> : null}
          </div>
        )}
      </div>
    </SettingsCard>
  );
}

/** Waiting on the browser, with the page one click away again. */
function Progress({ url, onCancel, children }: { url: string; onCancel: () => void; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line-subtle bg-surface-window py-1.5 pr-1.5 pl-3 text-meta">
      <RefreshCw size={13} strokeWidth={1.75} className="shrink-0 animate-spin text-fg-tertiary" />
      <p className="min-w-0 flex-1 text-fg-secondary">{children}</p>
      <a
        href={signInHref(url)}
        {...(WEB ? {} : { target: "_blank", rel: "noreferrer" })}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
      >
        <ExternalLink size={12} strokeWidth={1.75} />
        Open it again
      </a>
      <QuietButton onClick={onCancel}>Cancel</QuietButton>
    </div>
  );
}

/** What signing this device out does. */
const signOutDescription = WEB
  ? "This device leaves your account and forgets its sign-in. Your computers and their threads aren't touched."
  : "This computer leaves your account: your other devices won't see it or reach it until you sign in again. Its threads stay here.";

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

  return (
    <SettingsCard className="flex flex-col">
      <div className="flex items-center gap-3.5 p-4 max-md:flex-wrap max-md:gap-y-2">
        <Avatar name={name} email={email} imageUrl={imageUrl} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-reading font-medium text-fg-primary">
            {name ?? email ?? "Your account"}
          </span>
          {name !== undefined && email !== undefined ? (
            <span className="truncate text-meta text-fg-tertiary">{email}</span>
          ) : null}
        </div>
        {/* A phone has the width for the name, or for these: they go under it. */}
        <div className="flex shrink-0 items-center gap-3 max-md:basis-full max-md:justify-between max-md:pl-12.5">
          <ConnectionState connection={account.connection} />
          <QuietButton onClick={() => setConfirming(true)}>Sign out</QuietButton>
        </div>
      </div>
      {error ? (
        <p className="border-t border-line-subtle px-4 py-3 text-meta text-error-text">{error}</p>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Sign out of Cerium?"
        description={signOutDescription}
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
    <span className="grid size-9 shrink-0 place-items-center rounded-full border border-line-subtle bg-surface-raised text-meta font-medium text-fg-secondary">
      {initials(name, email)}
    </span>
  );
}

function ConnectionState({ connection }: { connection: SignedIn["connection"] }) {
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 text-meta ${
        connection === "offline" ? "text-attention-text" : "text-fg-tertiary"
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
      className="flex h-7 shrink-0 items-center rounded-md px-2 text-meta text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </Button>
  );
}

/** One device of the account, with what this one may do to it. */
function DeviceRow({ device, self, live }: { device: DeviceInfo; self: boolean; live: boolean }) {
  const rename = useAtomSet(renameDevice, { mode: "promise" });
  const remove = useAtomSet(removeDevice, { mode: "promise" });
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string>();
  const deviceId = device.id as DeviceId;
  // The build number is for telling builds apart when something's wrong: it waits in the menu.
  const version = deviceVersion(device);
  const details = deviceDetails(device);
  const Icon =
    device.kind === "desktop"
      ? Monitor
      : device.platform === "ios" || device.platform === "android"
        ? Smartphone
        : Globe;
  // A desktop too old to be driven is online, but no more reachable than an offline one.
  const outdated = device.kind === "desktop" && reachOf(device).kind === "outdated";
  // What the row says after its details: nothing while the device is simply there, a dot instead.
  const note =
    self || !live
      ? undefined
      : outdated
        ? "Update Cerium there first"
        : device.online
          ? undefined
          : presenceLabel(device);

  const run = (action: Promise<unknown>) => {
    setError(undefined);
    void action.catch((failure: unknown) => setError(messageOf(failure)));
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
          {live && device.online && !outdated ? (
            <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-surface-panel bg-success">
              <span className="sr-only">Online</span>
            </span>
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
                className="h-6 flex-1 text-body font-medium"
              />
            ) : (
              <span className="truncate text-body font-medium text-fg-primary" title={device.name}>
                {device.name}
              </span>
            )}
            {self && !editing ? (
              <span className="shrink-0 rounded-full border border-line-subtle px-1.5 text-caption leading-4 text-fg-tertiary">
                This {selfNoun}
              </span>
            ) : null}
          </div>
          {/* A phone has no room to cut the line short, so it wraps there. */}
          {details === "" && note === undefined ? null : (
            <span className="text-meta text-fg-tertiary max-md:[overflow-wrap:anywhere] md:truncate">
              {details}
              {note === undefined ? null : (
                <>
                  {details === "" ? null : " · "}
                  <span className={outdated ? "text-attention-text" : undefined}>{note}</span>
                </>
              )}
            </span>
          )}
        </div>
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
            {version === undefined ? null : (
              <MenuGroup>
                <MenuGroupLabel>{version}</MenuGroupLabel>
              </MenuGroup>
            )}
            <MenuItem icon={Pencil} onClick={() => setEditing(true)} disabled={!live}>
              Rename…
            </MenuItem>
            <MenuSeparator />
            {/* Signing out works offline too: this computer forgets its sign-in either way. */}
            <MenuItem icon={Trash2} tone="danger" onClick={() => setRemoving(true)} disabled={!live && !self}>
              {self ? "Sign out…" : "Remove…"}
            </MenuItem>
          </MenuPopup>
        </MenuRoot>
      </div>
      {error ? <p className="pl-11.5 text-meta text-error-text">{error}</p> : null}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={self ? "Sign out of Cerium?" : `Remove ${device.name}?`}
        description={
          self
            ? signOutDescription
            : `${device.name} signs out and leaves your account. Signing in there again brings it back.`
        }
        confirmLabel={self ? "Sign out" : "Remove"}
        onConfirm={() => run(remove({ payload: { deviceId } }))}
      />
    </div>
  );
}
