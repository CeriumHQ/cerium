import { Button } from "@base-ui/react/button";
import { Progress } from "@base-ui/react/progress";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import { accountAtom } from "../../backend/atoms.ts";
import { machineAtom } from "../../backend/machine.ts";
import { WEB } from "../../backend/target.ts";
import {
  onMac,
  onWindows,
  shellBridge,
  type StartAtLogin,
  type UpdateChannel,
  type Updates,
} from "../../backend/shell.ts";
import { SelectItem, SelectPopup, SelectRoot, SelectTrigger } from "../../components/ui/Select.tsx";
import { welcomeOpenAtom } from "../onboarding/state.ts";
import { speechLanguages, speechModel, speechModels, type SpeechModelId } from "../dictation/model.ts";
import { dictationLanguageAtom, dictationModelAtom, downloadedModelsAtom } from "../dictation/preferences.ts";
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
import { SettingsList, SettingsPage, SettingsRow, SettingsSection, SettingsSwitch } from "./parts.tsx";
import { RowButton } from "./ToolRow.tsx";
import { useSetting } from "./useSetting.ts";

// The desktop's own settings: how this computer starts and shows Cerium, dictation, and updates.

export function GeneralSettings() {
  const updates = useUpdates();
  const openWelcome = useAtomSet(welcomeOpenAtom);
  return (
    <SettingsPage
      title="General"
      action={
        // The welcome a desktop opens with on its first run, again: its themes, harnesses and account.
        WEB ? undefined : (
          <Button
            onClick={() => openWelcome(true)}
            className="flex h-7 items-center rounded-md px-2 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
          >
            Welcome tour
          </Button>
        )
      }
    >
      <ThisComputerSection />
      <DictationSection />
      {updates ? <UpdatesSection updates={updates} /> : null}
    </SettingsPage>
  );
}

/** Starting at login, signed in, and Discord's Rich Presence while it's this computer's window. */
function ThisComputerSection() {
  const account = AsyncResult.getOrElse(useAtomValue(accountAtom), () => undefined);
  const local = useAtomValue(machineAtom) === undefined;
  // Closing the window keeps a signed-in Cerium in the tray, which a start at login opens to.
  const startup = account?._tag === "SignedIn" && shellBridge()?.startAtLogin !== undefined;
  if (!startup && !local) return null;
  return (
    <SettingsSection title="This computer">
      <SettingsList>
        {startup ? <StartAtLoginRow /> : null}
        {local ? <DiscordRows /> : null}
      </SettingsList>
    </SettingsSection>
  );
}

function StartAtLoginRow() {
  const bridge = shellBridge();
  const windows = onWindows();
  const mac = onMac();
  const tray = mac ? "the menu bar" : "the tray";
  const [state, setState] = useState<StartAtLogin>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void bridge?.startAtLogin?.().then(setState, () => undefined);
  }, [bridge]);

  const change = (enabled: boolean) => {
    setError(undefined);
    setState((current) => current && { ...current, enabled });
    void bridge?.setStartAtLogin?.(enabled).then(setState, () => {
      setState((current) => current && { ...current, enabled: !enabled });
      setError(`${windows ? "Windows" : mac ? "macOS" : "The system"} didn't take that change. Try again.`);
    });
  };

  const label = windows ? "Start with Windows" : mac ? "Open at login" : "Start at login";
  return (
    <SettingsRow
      label={label}
      hint={
        state?.available === false
          ? `Only the installed app can ${windows ? "start with Windows" : mac ? "open at login" : "start at login"}.`
          : `Opens in ${tray}, so your other devices can reach this computer after a restart.`
      }
      error={error}
      control={(labelledBy) => (
        <SettingsSwitch
          checked={state?.enabled ?? false}
          onCheckedChange={change}
          disabled={state?.available !== true}
          labelledBy={labelledBy}
        />
      )}
    />
  );
}

/**
 * Discord Rich Presence through the Discord app on this computer (apps/backend/src/discord.ts). Off
 * until asked for, and saved by the backend; not offered while the window drives another machine,
 * whose Discord isn't the one in front of the user.
 */
function DiscordRows() {
  const { value, saved, save, error } = useSetting("discord", { enabled: false, showProject: false });
  return (
    <>
      <SettingsRow
        label="Show activity on Discord"
        hint="How many agents are working, and in which harnesses. Never titles or messages."
        error={error}
        control={(labelledBy) => (
          <SettingsSwitch
            checked={value.enabled}
            onCheckedChange={(on) => save({ ...value, enabled: on })}
            disabled={saved === undefined}
            labelledBy={labelledBy}
          />
        )}
      />
      {value.enabled ? (
        <SettingsRow
          label="Name the project"
          hint="Adds the folder agents work in, such as “in cerium”."
          control={(labelledBy) => (
            <SettingsSwitch
              checked={value.showProject}
              onCheckedChange={(on) => save({ ...value, showProject: on })}
              disabled={saved === undefined}
              labelledBy={labelledBy}
            />
          )}
        />
      ) : null}
    </>
  );
}

const languageName = (code: string) => speechLanguages.find(([each]) => each === code)?.[1] ?? code;

/** Dictation's language and speech model; the microphone button sits in every message box. */
function DictationSection() {
  const [language, setLanguage] = useAtom(dictationLanguageAtom);
  const [model, setModel] = useAtom(dictationModelAtom);
  const downloaded = useAtomValue(downloadedModelsAtom);
  const sizeOf = (id: SpeechModelId) =>
    downloaded.includes(id) ? "Downloaded" : `About ${speechModel(id).size} MB`;

  return (
    <SettingsSection
      title="Dictation"
      description="OpenAI's Whisper turns speech into text on this computer. Its model downloads once, the first time you dictate."
    >
      <SettingsList>
        <SettingsRow
          label="Language"
          className="pr-2.5"
          control={() => (
            <SelectRoot value={language} onValueChange={(next) => next !== null && setLanguage(next)}>
              <SelectTrigger label="Dictation language">{languageName(language)}</SelectTrigger>
              <SelectPopup>
                {speechLanguages.map(([code, name]) => (
                  <SelectItem key={code} value={code}>
                    {name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </SelectRoot>
          )}
        />
        <SettingsRow
          label="Speech model"
          hint={sizeOf(model)}
          className="pr-2.5"
          control={() => (
            <SelectRoot
              value={model}
              onValueChange={(next) => next !== null && setModel(next as SpeechModelId)}
            >
              <SelectTrigger label="Speech model">{speechModel(model).label}</SelectTrigger>
              <SelectPopup>
                {speechModels.map((each) => (
                  <SelectItem key={each.id} value={each.id} description={`${each.note} · ${sizeOf(each.id)}`}>
                    {each.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </SelectRoot>
          )}
        />
      </SettingsList>
    </SettingsSection>
  );
}

const channelHint: Record<UpdateChannel, string> = {
  stable: "Tested releases, at most one a day",
  nightly: "Every change as it lands, with rough edges",
};

/** Ticks once a minute, so "Checked 5 minutes ago" keeps up. */
function useMinute() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The installed version and where the updater stands, and the channel it follows. Nothing downloads unasked. */
function UpdatesSection({ updates }: { updates: Updates }) {
  const openWhatsNew = useAtomSet(whatsNewOpenAtom);
  const now = useMinute();
  const { status } = updates;
  const bridge = shellBridge();
  const at = checkedAt(status);
  const locked = channelLocked(status);
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
    <SettingsSection title="Updates">
      <SettingsList>
        <div className="flex flex-col gap-2.5 px-4 py-3">
          <div className="flex items-center gap-4">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-2 text-[13px] font-medium text-fg-primary">
                {versionLabel(updates.version)}
                <span className="rounded-md bg-surface-hover px-1.5 py-px text-[11.5px] font-medium text-fg-secondary">
                  {channelLabel[updates.buildChannel]}
                </span>
              </span>
              <span
                role={failed ? "alert" : "status"}
                className={`text-xs leading-relaxed ${failed ? "text-error" : "text-fg-tertiary"}`}
              >
                {statusText(updates)}
                {at !== undefined ? (
                  <span className="text-fg-tertiary"> {checkedLabel(at, now)}.</span>
                ) : null}
              </span>
            </div>
            <span className="flex shrink-0 items-center gap-1.5">
              {offered !== undefined ? (
                <a
                  href={releaseNotesUrl(offered)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
                >
                  <ExternalLink size={12} strokeWidth={1.75} />
                  What's new in {offered}
                </a>
              ) : (
                <Button
                  onClick={() => openWhatsNew(true)}
                  className="flex h-7 items-center rounded-md px-2 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
                >
                  What's new
                </Button>
              )}
              {status.kind === "available" || status.kind === "failed" ? (
                <RowButton tone="primary" onClick={() => void bridge?.downloadUpdate?.()}>
                  {status.kind === "failed"
                    ? "Try again"
                    : `${updates.manual ? "Download" : "Update to"} ${status.version}`}
                </RowButton>
              ) : status.kind === "ready" ? (
                <RowButton tone="primary" onClick={() => void bridge?.installUpdate?.()}>
                  Restart to update
                </RowButton>
              ) : status.kind === "downloading" || status.kind === "unsupported" ? null : (
                <RowButton onClick={() => void bridge?.checkForUpdates?.()}>
                  {status.kind === "checking" ? "Checking…" : "Check for updates"}
                </RowButton>
              )}
            </span>
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
        </div>
        <SettingsRow
          label="Channel"
          hint={locked ? "Finish the update first, then you can switch." : channelHint[updates.channel]}
          className="pr-2.5"
          control={() => (
            <SelectRoot
              value={updates.channel}
              onValueChange={(next) => next !== null && void bridge?.setUpdateChannel?.(next)}
              disabled={locked || status.kind === "unsupported"}
            >
              <SelectTrigger label="Update channel">{channelLabel[updates.channel]}</SelectTrigger>
              <SelectPopup>
                {(["stable", "nightly"] as const).map((id) => (
                  <SelectItem key={id} value={id} description={channelHint[id]}>
                    {channelLabel[id]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </SelectRoot>
          )}
        />
      </SettingsList>
    </SettingsSection>
  );
}
