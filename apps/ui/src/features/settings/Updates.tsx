import { Button } from "@base-ui/react/button";
import { Progress } from "@base-ui/react/progress";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { useAtomSet } from "@effect/atom-react";
import { ExternalLink, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { shellBridge, type UpdateChannel, type Updates } from "../../backend/shell.ts";
import {
  channelLabel,
  channelLocked,
  checkedAt,
  checkedLabel,
  releaseNotesUrl,
  statusText,
  versionLabel,
} from "../updates/model.ts";
import { useUpdates } from "../updates/useUpdates.ts";
import { whatsNewOpenAtom } from "../whatsnew/state.ts";
import { SettingsCard, SettingsPage, SettingsSection } from "./parts.tsx";

const channels: ReadonlyArray<{ readonly id: UpdateChannel; readonly description: string }> = [
  { id: "stable", description: "Tested releases, at most one a day. Most people want this one." },
  { id: "nightly", description: "Every change as it lands. Expect rough edges." },
];

const buttonClass =
  "flex h-8 shrink-0 items-center gap-2 rounded-lg px-3 text-[13px] font-medium transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring data-disabled:opacity-40";
const primaryClass = `${buttonClass} bg-accent text-accent-fg hover:bg-accent-strong`;
const secondaryClass = `${buttonClass} border border-line-subtle bg-surface-raised text-fg-primary shadow-raised hover:bg-surface-panel active:bg-surface-active`;

export function UpdateSettings() {
  const updates = useUpdates();
  return (
    <SettingsPage title="Updates" description="Nothing downloads until you say so.">
      {updates ? (
        <>
          <ChannelSection updates={updates} />
          <VersionSection updates={updates} />
        </>
      ) : null}
    </SettingsPage>
  );
}

function ChannelSection({ updates }: { updates: Updates }) {
  const locked = channelLocked(updates.status);
  const unsupported = updates.status.kind === "unsupported";
  return (
    <SettingsSection
      title="Channel"
      description={
        locked
          ? "Finish the update first, then you can switch."
          : "Your threads and settings stay as they are when you switch."
      }
    >
      <RadioGroup
        value={updates.channel}
        onValueChange={(value) => void shellBridge()?.setUpdateChannel?.(value as UpdateChannel)}
        disabled={locked || unsupported}
        aria-label="Update channel"
        className="grid gap-3 sm:grid-cols-2"
      >
        {channels.map(({ id, description }) => (
          <Radio.Root
            key={id}
            value={id}
            nativeButton
            render={<button type="button" aria-label={channelLabel[id]} />}
            className="group flex items-start gap-3 rounded-xl border border-line-subtle p-4 text-left outline-none transition-[border-color,box-shadow,background-color] duration-150 hover:border-line-strong focus-visible:ring-2 focus-visible:ring-focus-ring data-checked:border-accent data-checked:bg-accent/4 data-checked:ring-1 data-checked:ring-accent data-disabled:pointer-events-none data-disabled:opacity-50"
          >
            <span className="mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full border border-line-strong transition-colors group-data-checked:border-accent group-data-checked:bg-accent">
              <Radio.Indicator className="size-1.5 rounded-full bg-accent-fg" />
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-[13px] font-medium text-fg-primary">{channelLabel[id]}</span>
              <span className="text-[12.5px] leading-relaxed text-fg-tertiary">{description}</span>
            </span>
          </Radio.Root>
        ))}
      </RadioGroup>
    </SettingsSection>
  );
}

/** Ticks once a minute, so "Checked 5 minutes ago" keeps up. */
function useMinute() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function VersionSection({ updates }: { updates: Updates }) {
  const openWhatsNew = useAtomSet(whatsNewOpenAtom);
  const now = useMinute();
  const { status } = updates;
  const bridge = shellBridge();
  const at = checkedAt(status);
  // Releases nobody can read yet just mean updates are off; a network or download problem is an error.
  const failed = status.kind === "failed" || (status.kind === "unreachable" && status.reason === "offline");
  // A release on offer, or being installed, has its notes a click away.
  const offered =
    status.kind === "available" ||
    status.kind === "downloading" ||
    status.kind === "ready" ||
    status.kind === "failed"
      ? status.version
      : undefined;

  return (
    <SettingsSection title="This version">
      <SettingsCard className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex items-center gap-2 text-[13px] font-medium text-fg-primary">
              {versionLabel(updates.version)}
              <span className="rounded-md bg-surface-hover px-1.5 py-px text-[11.5px] font-medium text-fg-secondary">
                {channelLabel[updates.buildChannel]}
              </span>
            </span>
            <p
              role={failed ? "alert" : "status"}
              className={`text-[12.5px] leading-relaxed ${failed ? "text-error" : "text-fg-tertiary"}`}
            >
              {statusText(updates)}
              {at !== undefined ? <span className="text-fg-tertiary"> {checkedLabel(at, now)}.</span> : null}
            </p>
            <button
              type="button"
              onClick={() => openWhatsNew(true)}
              className="mt-1 flex w-fit items-center gap-1.5 rounded-md text-[12.5px] text-fg-secondary transition-colors hover:text-fg-primary"
            >
              <Sparkles size={12} strokeWidth={1.75} />
              What's new in this version
            </button>
            {offered !== undefined ? (
              <a
                href={releaseNotesUrl(offered)}
                target="_blank"
                rel="noreferrer"
                className="mt-1 flex w-fit items-center gap-1.5 rounded-md text-[12.5px] text-fg-secondary transition-colors hover:text-fg-primary"
              >
                <ExternalLink size={12} strokeWidth={1.75} />
                What's new in {offered}
              </a>
            ) : null}
          </div>
          {status.kind === "available" || status.kind === "failed" ? (
            <Button onClick={() => void bridge?.downloadUpdate?.()} className={primaryClass}>
              {status.kind === "failed"
                ? "Try again"
                : `${updates.manual ? "Download" : "Update to"} ${status.version}`}
            </Button>
          ) : status.kind === "ready" ? (
            <Button onClick={() => void bridge?.installUpdate?.()} className={primaryClass}>
              Restart to update
            </Button>
          ) : status.kind === "downloading" ? null : (
            <Button
              onClick={() => void bridge?.checkForUpdates?.()}
              disabled={status.kind === "unsupported" || status.kind === "checking"}
              className={secondaryClass}
            >
              {status.kind === "checking" ? "Checking…" : "Check for updates"}
            </Button>
          )}
        </div>
        {status.kind === "downloading" ? (
          <Progress.Root
            value={Math.floor(status.percent)}
            aria-label={`Downloading ${versionLabel(status.version)}`}
          >
            <div className="flex items-center gap-3">
              <Progress.Track className="h-1 flex-1 overflow-hidden rounded-full bg-line-strong">
                <Progress.Indicator className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out-soft" />
              </Progress.Track>
              <Progress.Value className="w-9 text-right text-[12px] text-fg-tertiary tabular-nums" />
            </div>
          </Progress.Root>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
