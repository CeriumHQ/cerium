import { NOTIFICATION_KINDS, type NotificationKind } from "@cerium/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { EllipsisVertical, Share, SquarePlus } from "lucide-react";
import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";

import { accountAtom, subscribePush, unsubscribePush } from "../../backend/atoms.ts";
import { thisBrowser } from "../../web/device.ts";
import {
  notificationsOf,
  PushBlocked,
  pushSupport,
  relayPushKey,
  turnOffPush,
  turnOnPush,
} from "../../web/push.ts";
import { SettingsCard, SettingsPage, SettingsSection, SettingsSwitch } from "./parts.tsx";

// Push notifications on this phone, tablet or browser: turning them on,
// and which kinds. Only the web client has this page. Some mobile browsers notify only web apps on
// the Home Screen; there it says how to put Cerium there first.

const kindText: Record<NotificationKind, { readonly label: string; readonly description: string }> = {
  needsYou: {
    label: "An agent needs you",
    description: "It waits for your approval to run a command, change files or start another agent.",
  },
  finished: { label: "A thread finishes", description: "Its agents are done, and it's your turn." },
  failed: { label: "Something fails", description: "An agent stopped with an error." },
};

/** Whether this is a phone or a tablet, or just a browser. */
const deviceNoun = () => {
  const { name, platform } = thisBrowser();
  if (platform !== "ios" && platform !== "android") return "browser";
  return /iPad|tablet/.test(name) ? "tablet" : "phone";
};

const onVisibility = (change: () => void) => {
  document.addEventListener("visibilitychange", change);
  return () => document.removeEventListener("visibilitychange", change);
};
/** Whether the browser lets Cerium notify; read again when the user comes back from its settings. */
const permission = (): NotificationPermission =>
  "Notification" in window ? Notification.permission : "default";

const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "Something went wrong. Try again.";

export function NotificationSettings() {
  const noun = deviceNoun();
  const support = pushSupport();
  return (
    <SettingsPage
      title="Notifications"
      description={`Cerium can tell this ${noun} when an agent needs you, a thread finishes or something fails, on any of your computers.`}
    >
      {support === "supported" ? (
        <PushSettings noun={noun} />
      ) : (
        <SettingsSection title={`On this ${noun}`}>
          {support === "install" ? (
            <InstallSteps />
          ) : (
            <Note>This browser can't show notifications from Cerium.</Note>
          )}
        </SettingsSection>
      )}
    </SettingsPage>
  );
}

function PushSettings({ noun }: { noun: string }) {
  const result = useAtomValue(accountAtom);
  const account = AsyncResult.isSuccess(result) ? result.value : undefined;
  const subscribe = useAtomSet(subscribePush, { mode: "promise" });
  const unsubscribe = useAtomSet(unsubscribePush, { mode: "promise" });
  const allowed = useSyncExternalStore(onVisibility, permission);
  /** The relay's key; `null` when it sends no notifications. */
  const [key, setKey] = useState<string | null>();
  useEffect(() => {
    void relayPushKey().then((found) => setKey(found ?? null));
  }, []);
  const saved = account === undefined ? undefined : notificationsOf(account);
  /**
   * What the user just chose (`null` for off), shown over what the relay had then (`over`) until it
   * says something new.
   */
  const [chosen, setChosen] = useState<{
    readonly kinds: ReadonlyArray<NotificationKind> | null;
    readonly over: string;
  }>();
  const [error, setError] = useState<string>();
  const savedKey = JSON.stringify(saved ?? null);
  const kinds = chosen !== undefined && chosen.over === savedKey ? (chosen.kinds ?? undefined) : saved;
  const online = account?._tag === "SignedIn" && account.connection === "online";
  const masterId = useId();

  const blockedText =
    noun === "browser"
      ? "This browser blocks notifications from Cerium. Allow them in its settings for this site, then try again."
      : `Notifications for Cerium are off in this ${noun}'s settings. Turn them on there, then try again.`;

  const failed = (cause: unknown) => {
    setChosen(undefined);
    setError(
      cause instanceof PushBlocked
        ? cause.message === "denied"
          ? blockedText
          : "Cerium can't notify you until you allow it."
        : messageOf(cause),
    );
  };

  /** Subscribes for `next`; the browser asks first if it hasn't yet, which needs this tap. */
  const choose = (next: ReadonlyArray<NotificationKind>) => {
    if (typeof key !== "string") return;
    setError(undefined);
    setChosen({ kinds: next, over: savedKey });
    turnOnPush(key)
      .then((subscription) => subscribe({ payload: { subscription, kinds: next } }))
      .catch(failed);
  };

  const turnOff = () => {
    setError(undefined);
    setChosen({ kinds: null, over: savedKey });
    unsubscribe({ payload: undefined })
      .then(() => turnOffPush())
      .catch(failed);
  };

  const toggleKind = (kind: NotificationKind, on: boolean) => {
    const next = NOTIFICATION_KINDS.filter((each) => (each === kind ? on : (kinds ?? []).includes(each)));
    if (next.length === 0) turnOff();
    else choose(next);
  };

  if (key === undefined) return <Note>Checking…</Note>;
  if (key === null) return <Note>Cerium's cloud can't send notifications yet.</Note>;

  return (
    <>
      <SettingsSection title={`On this ${noun}`}>
        <SettingsCard className="flex items-start gap-4 p-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span id={masterId} className="text-[13px] font-medium text-fg-primary max-md:text-[15px]">
              Allow notifications
            </span>
            <p className="text-[12.5px] leading-relaxed text-fg-tertiary max-md:text-[13.5px]">
              {allowed === "denied"
                ? blockedText
                : online
                  ? "They arrive while Cerium is closed or in the background, like any app's."
                  : "Connect to Cerium's cloud to change this."}
            </p>
            {error ? <p className="text-[12.5px] text-error max-md:text-[13.5px]">{error}</p> : null}
          </div>
          <SettingsSwitch
            checked={kinds !== undefined}
            onCheckedChange={(on) => (on ? choose(NOTIFICATION_KINDS) : turnOff())}
            disabled={!online || allowed === "denied"}
            labelledBy={masterId}
          />
        </SettingsCard>
      </SettingsSection>
      {kinds === undefined ? null : (
        <SettingsSection
          title="Tell me when"
          description="You aren't told about a thread you have open on any of your devices, or anything while Cerium is open here."
        >
          <SettingsCard className="flex flex-col divide-y divide-line-subtle">
            {NOTIFICATION_KINDS.map((kind) => (
              <KindRow
                key={kind}
                kind={kind}
                checked={kinds.includes(kind)}
                disabled={!online}
                onChange={(on) => toggleKind(kind, on)}
              />
            ))}
          </SettingsCard>
        </SettingsSection>
      )}
    </>
  );
}

function KindRow({
  kind,
  checked,
  disabled,
  onChange,
}: {
  kind: NotificationKind;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  const labelId = useId();
  const { label, description } = kindText[kind];
  return (
    <div className="flex items-start gap-4 p-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span id={labelId} className="text-[13px] font-medium text-fg-primary max-md:text-[15px]">
          {label}
        </span>
        <p className="text-[12.5px] leading-relaxed text-fg-tertiary max-md:text-[13.5px]">{description}</p>
      </div>
      <SettingsSwitch checked={checked} onCheckedChange={onChange} disabled={disabled} labelledBy={labelId} />
    </div>
  );
}

/** A mobile browser that notifies only web apps on the Home Screen: how to put Cerium there. */
function InstallSteps() {
  const icon = "inline -translate-y-px";
  const steps: ReadonlyArray<ReactNode> = [
    <>
      Tap <Share size={15} strokeWidth={1.75} aria-hidden className={icon} /> Share or the{" "}
      <EllipsisVertical size={15} strokeWidth={1.75} aria-hidden className={icon} /> menu.
    </>,
    <>
      Choose <SquarePlus size={15} strokeWidth={1.75} aria-hidden className={icon} /> Add to Home Screen, or
      Install app.
    </>,
    <>Open Cerium from your Home Screen, and turn notifications on here.</>,
  ];
  return (
    <SettingsCard className="flex flex-col gap-3 p-4">
      <p className="text-[13px] leading-relaxed text-fg-secondary max-md:text-[15px]">
        This browser notifies web apps once they're on your Home Screen.
      </p>
      <ol className="flex flex-col gap-2.5">
        {steps.map((step, index) => (
          <li
            key={index}
            className="flex items-baseline gap-3 text-[13px] text-fg-primary max-md:text-[15px]"
          >
            <span className="grid size-5 shrink-0 translate-y-[-1px] place-items-center rounded-full bg-surface-raised text-2xs font-medium text-fg-secondary tabular-nums">
              {index + 1}
            </span>
            <span className="leading-relaxed">{step}</span>
          </li>
        ))}
      </ol>
    </SettingsCard>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <SettingsCard className="px-4 py-5 text-[13px] leading-relaxed text-fg-tertiary max-md:text-[15px]">
      {children}
    </SettingsCard>
  );
}
