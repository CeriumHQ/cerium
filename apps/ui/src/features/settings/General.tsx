import { SLIM_AFTER_DAYS, type SlimThreadsAfter } from "@cerium/protocol";
import { Button } from "@base-ui/react/button";
import { Progress } from "@base-ui/react/progress";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ArrowDown, ArrowUpRight, CircleAlert, RefreshCw, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";

import { accountAtom } from "../../backend/atoms.ts";
import { machineAtom } from "../../backend/machine.ts";
import {
  onMac,
  onWindows,
  shellBridge,
  type CrashReportsState,
  type StartAtLogin,
  type UpdateChannel,
  type Updates,
} from "../../backend/shell.ts";
import { SelectItem, SelectPopup, SelectRoot, SelectTrigger } from "../../components/ui/Select.tsx";
import { useEditors } from "../editor/useEditor.ts";
import { welcomeOpenAtom } from "../onboarding/state.ts";
import { speechLanguages, speechModel, speechModels, type SpeechModelId } from "../dictation/model.ts";
import { dictationLanguageAtom, dictationModelAtom, downloadedModelsAtom } from "../dictation/preferences.ts";
import {
  channelLabel,
  channelLocked,
  checkedAt,
  checkedLabel,
  offerVersion,
  releaseNotesUrl,
  statusText,
  versionLabel,
  versionParts,
} from "../updates/model.ts";
import { useRestartToUpdate, useUpdates } from "../updates/useUpdates.ts";
import { whatsNewOpenAtom } from "../whatsnew/state.ts";
import {
  SettingsList,
  SettingsNote,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "./parts.tsx";
import { editorAtom } from "./preferences.ts";
import { RowButton } from "./ToolRow.tsx";
import { DEFAULT_LIMIT_POLICY, limitLabel, limitPolicies } from "./limits.ts";
import { useSetting } from "./useSetting.ts";

// The desktop's own pages: how this computer starts Cerium and keeps its threads, dictation, updates
// and Discord.

/**
 * Starting at login, signed in; slimming old threads while it's this computer's window; crash
 * reports. The welcome a desktop opens with on its first run is a click away again.
 */
export function GeneralSettings() {
  const openWelcome = useAtomSet(welcomeOpenAtom);
  const account = AsyncResult.getOrElse(useAtomValue(accountAtom), () => undefined);
  const local = useAtomValue(machineAtom) === undefined;
  // Closing the window keeps a signed-in Cerium in the tray, which a start at login opens to.
  const startup = account?._tag === "SignedIn" && shellBridge()?.startAtLogin !== undefined;
  return (
    <SettingsPage
      title="General"
      action={
        <Button
          onClick={() => openWelcome(true)}
          className="flex h-7 items-center rounded-md px-2 text-meta text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
        >
          Welcome tour
        </Button>
      }
    >
      {startup ? (
        <SettingsSection title="Startup">
          <SettingsList>
            <StartAtLoginRow />
          </SettingsList>
        </SettingsSection>
      ) : null}
      {local && shellBridge()?.editors !== undefined ? (
        <SettingsSection title="Editor">
          <SettingsList>
            <EditorRow />
          </SettingsList>
        </SettingsSection>
      ) : null}
      <SettingsSection title="Usage limits">
        <SettingsList>
          <OnLimitRow />
        </SettingsList>
      </SettingsSection>
      {local ? (
        <SettingsSection title="Storage">
          <SettingsList>
            <SlimThreadsRow />
          </SettingsList>
        </SettingsSection>
      ) : null}
      <CrashReportsSection />
    </SettingsPage>
  );
}

/**
 * What threads do when their harness's plan or usage limit runs out mid-turn, unless a thread or an
 * automation chooses otherwise. Applies on the machine the agents run on.
 */
function OnLimitRow() {
  const { value, saved, save, error } = useSetting("limits", { onLimit: DEFAULT_LIMIT_POLICY });
  return (
    <SettingsRow
      label="When a limit runs out"
      hint={limitPolicies.find((each) => each.value === value.onLimit)?.hint ?? ""}
      error={error}
      control={() => (
        <SelectRoot
          value={value.onLimit}
          onValueChange={(next) => {
            const policy = limitPolicies.find((each) => each.value === next);
            if (policy) save({ onLimit: policy.value });
          }}
          disabled={saved === undefined}
        >
          <SelectTrigger label="When a limit runs out">{limitLabel[value.onLimit]}</SelectTrigger>
          <SelectPopup>
            {limitPolicies.map((policy) => (
              <SelectItem key={policy.value} value={policy.value}>
                {limitLabel[policy.value]}
              </SelectItem>
            ))}
          </SelectPopup>
        </SelectRoot>
      )}
    />
  );
}

/** Discord's Rich Presence, while the window is this computer's: another machine's Discord isn't in front of the user. */
export function DiscordSettings() {
  const driven = useAtomValue(machineAtom);
  return (
    <SettingsPage
      title="Discord"
      description="Your Discord status shows agents at work, through Discord on this computer."
    >
      {driven === undefined ? (
        <SettingsList>
          <DiscordRows />
        </SettingsList>
      ) : (
        <SettingsNote>
          Discord shows this computer's agents. Switch back to it from {driven.name} to change this.
        </SettingsNote>
      )}
    </SettingsPage>
  );
}

/** The installed version, the updater, and where it takes its releases from. */
export function UpdateSettings() {
  const updates = useUpdates();
  return (
    <SettingsPage title="Updates">
      {updates ? <UpdatesSection updates={updates} /> : <SettingsNote>Checking…</SettingsNote>}
    </SettingsPage>
  );
}

const slimLabel: Record<SlimThreadsAfter, string> = {
  0: "Never",
  1: "After a day",
  3: "After 3 days",
  7: "After a week",
  14: "After 2 weeks",
  30: "After 30 days",
};

/**
 * How long a thread on this computer goes quiet before its screenshots and the harnesses' raw data go
 * (apps/backend/src/slimming.ts), which keeps the database small; not offered while driving another
 * machine, whose backend keeps its own threads.
 */
function SlimThreadsRow() {
  const { value, saved, save, error } = useSetting("slimThreadsAfter", 7);
  return (
    <SettingsRow
      label="Slim old threads"
      hint="Removes screenshots and raw harness data from quiet threads. Text stays."
      error={error}
      control={() => (
        <SelectRoot
          value={String(value)}
          onValueChange={(next) => {
            const days = SLIM_AFTER_DAYS.find((each) => String(each) === next);
            if (days !== undefined) save(days);
          }}
          disabled={saved === undefined}
        >
          <SelectTrigger label="Slim old threads">{slimLabel[value]}</SelectTrigger>
          <SelectPopup>
            {SLIM_AFTER_DAYS.map((days) => (
              <SelectItem key={days} value={String(days)}>
                {slimLabel[days]}
              </SelectItem>
            ))}
          </SelectPopup>
        </SelectRoot>
      )}
    />
  );
}

/**
 * The editor files open in at their line, from the ones installed on this computer; the first one found
 * until the user picks. "File manager" turns opening in an editor off.
 */
function EditorRow() {
  const editors = useEditors();
  const [choice, setChoice] = useAtom(editorAtom);
  const chosen = editors?.find((each) => each.id === choice);
  const current =
    choice === "none" ? "None" : (chosen ?? (choice === "auto" ? editors?.[0] : undefined))?.label;
  const none = editors !== undefined && editors.length === 0;
  return (
    <SettingsRow
      label="Open files in"
      hint={
        none
          ? "No editor found: VS Code, Cursor, Zed, a JetBrains IDE or Visual Studio."
          : "File chips, diffs and tool calls open at their line."
      }
      className="pr-2.5"
      control={() => (
        <SelectRoot
          value={choice === "auto" || choice === "none" || chosen ? choice : "auto"}
          onValueChange={(next) => next !== null && setChoice(next)}
          disabled={editors === undefined || none}
        >
          <SelectTrigger label="Editor">{current ?? "…"}</SelectTrigger>
          <SelectPopup>
            <SelectItem value="auto">{`Automatic${editors?.[0] ? ` (${editors[0].label})` : ""}`}</SelectItem>
            {editors?.map((each) => (
              <SelectItem key={each.id} value={each.id}>
                {each.label}
              </SelectItem>
            ))}
            <SelectItem value="none">None</SelectItem>
          </SelectPopup>
        </SelectRoot>
      )}
    />
  );
}

/**
 * Anonymous crash reports from this computer (apps/desktop/src/crashReports.ts), on until turned off;
 * absent from builds that send none, such as development's.
 */
function CrashReportsSection() {
  const bridge = shellBridge();
  const [state, setState] = useState<CrashReportsState>();

  useEffect(() => {
    void bridge?.crashReports?.().then(setState, () => undefined);
  }, [bridge]);

  if (state?.available !== true) return null;
  const change = (enabled: boolean) => {
    setState({ ...state, enabled });
    void bridge?.setCrashReports?.(enabled).then(setState, () => setState({ ...state, enabled: !enabled }));
  };
  return (
    <SettingsSection title="Privacy">
      <SettingsList>
        <SettingsRow
          label="Send crash reports"
          hint="Anonymous: what failed and where. Never messages, files or paths."
          control={(labelledBy) => (
            <SettingsSwitch checked={state.enabled} onCheckedChange={change} labelledBy={labelledBy} />
          )}
        />
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
export function DictationSettings() {
  const [language, setLanguage] = useAtom(dictationLanguageAtom);
  const [model, setModel] = useAtom(dictationModelAtom);
  const downloaded = useAtomValue(downloadedModelsAtom);
  const sizeOf = (id: SpeechModelId) =>
    downloaded.includes(id) ? "Downloaded" : `About ${speechModel(id).size} MB`;

  return (
    <SettingsPage
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
    </SettingsPage>
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

/**
 * The installed version and where the updater stands, the channel it follows, and whether updates
 * download by themselves.
 */
function UpdatesSection({ updates }: { updates: Updates }) {
  const openWhatsNew = useAtomSet(whatsNewOpenAtom);
  const now = useMinute();
  const { status } = updates;
  const bridge = shellBridge();
  const at = checkedAt(status);
  const locked = channelLocked(status);
  const installed = versionParts(updates.version);
  // Releases nobody can read yet just mean updates are off; a network problem is an error.
  const offline = status.kind === "unreachable" && status.reason === "offline";

  return (
    <SettingsList>
      <div className="flex flex-col">
        <div className="flex min-h-14 items-center gap-4 px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex items-center gap-2" title={updates.version}>
              <span className="text-body font-medium text-fg-primary tabular-nums">
                Cerium {installed.release}
              </span>
              <span className="rounded-md bg-surface-hover px-1.5 py-px text-meta font-medium text-fg-secondary tabular-nums">
                {channelLabel[updates.buildChannel]}
                {installed.build !== undefined ? ` ${installed.build}` : null}
              </span>
            </span>
            {offerVersion(status) === undefined ? (
              <span
                role={offline ? "alert" : "status"}
                className={`text-meta leading-relaxed ${offline ? "text-error-text" : "text-fg-tertiary"}`}
              >
                {statusText(updates)}
                {at !== undefined ? (
                  <span className="text-fg-tertiary"> {checkedLabel(at, now)}.</span>
                ) : null}
              </span>
            ) : null}
          </div>
          <span className="flex shrink-0 items-center gap-1.5">
            <Button
              onClick={() => openWhatsNew(true)}
              className="flex h-7 items-center rounded-md px-2 text-meta text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
            >
              What's new
            </Button>
            {status.kind === "current" || status.kind === "unreachable" || status.kind === "checking" ? (
              <Button
                onClick={() => void bridge?.checkForUpdates?.()}
                disabled={status.kind === "checking"}
                className="flex h-7 items-center gap-1.5 rounded-md border border-line-subtle px-2.5 text-meta font-medium text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary disabled:pointer-events-none disabled:opacity-60"
              >
                <RefreshCw
                  size={12}
                  strokeWidth={2}
                  aria-hidden="true"
                  className={status.kind === "checking" ? "animate-spin" : undefined}
                />
                {status.kind === "checking" ? "Checking" : "Check now"}
              </Button>
            ) : null}
          </span>
        </div>
        <UpdateOffer updates={updates} />
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
      {/* A Mac build that can't install updates itself has nothing to download ahead. */}
      {status.kind === "unsupported" || updates.manual ? null : (
        <SettingsRow
          label="Download automatically"
          hint="Updates download in the background, ready for your next restart."
          control={(labelledBy) => (
            <SettingsSwitch
              checked={updates.autoDownload}
              onCheckedChange={(on) => void bridge?.setAutoDownload?.(on)}
              labelledBy={labelledBy}
            />
          )}
        />
      )}
    </SettingsList>
  );
}

/** The release on offer, from download to restart, in a tinted panel under the installed version. */
function UpdateOffer({ updates }: { updates: Updates }) {
  const { status } = updates;
  const bridge = shellBridge();
  const { confirming, restart, cancel } = useRestartToUpdate();
  const version = offerVersion(status);
  if (version === undefined) return null;
  const failed = status.kind === "failed";
  const restarting = status.kind === "installing";
  const name = versionLabel(version);
  const Icon = failed ? CircleAlert : status.kind === "ready" || restarting ? RotateCw : ArrowDown;

  return (
    <div
      role={failed ? "alert" : "status"}
      className={`mx-2 mb-2 flex items-center gap-3 rounded-lg py-2.5 pr-2.5 pl-3 ${failed ? "bg-error/6" : "bg-accent-soft"}`}
    >
      <span
        className={`grid size-7 shrink-0 place-items-center rounded-full ${failed ? "bg-error/15 text-error-text" : "bg-accent text-accent-fg"}`}
      >
        <Icon
          size={14}
          strokeWidth={2}
          aria-hidden="true"
          className={restarting ? "animate-spin" : undefined}
        />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body font-medium text-fg-primary" title={version}>
          {status.kind === "available"
            ? `${name} is available`
            : status.kind === "downloading"
              ? `Downloading ${name}`
              : status.kind === "ready"
                ? `${name} is ready`
                : restarting
                  ? `Restarting to install ${name}`
                  : `Couldn't download ${name}`}
        </span>
        {status.kind === "downloading" ? (
          <Progress.Root value={Math.floor(status.percent)} aria-label={`Downloading ${name}`}>
            <div className="flex h-4 items-center gap-2.5">
              <Progress.Track className="h-1 flex-1 overflow-hidden rounded-full bg-line-strong">
                <Progress.Indicator className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out-soft" />
              </Progress.Track>
              <Progress.Value className="w-8 text-right text-meta text-fg-tertiary tabular-nums" />
            </div>
          </Progress.Root>
        ) : (
          <span className="truncate text-meta text-fg-tertiary">
            {status.kind === "ready" && confirming ? (
              "Restarting stops the agents that are working."
            ) : status.kind === "ready" ? (
              "Installs when you restart or quit."
            ) : restarting ? (
              "Cerium opens again when it's done."
            ) : status.kind === "available" && updates.manual ? (
              "Downloads in your browser; drag it into Applications."
            ) : failed ? (
              "Check your connection and try again."
            ) : (
              <a
                href={releaseNotesUrl(version)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 transition-colors hover:text-fg-primary"
              >
                Release notes
                <ArrowUpRight size={11} strokeWidth={2} aria-hidden="true" />
              </a>
            )}
          </span>
        )}
      </div>
      {status.kind === "available" || failed ? (
        <RowButton tone="primary" onClick={() => void bridge?.downloadUpdate?.()}>
          {failed ? "Try again" : updates.manual ? "Download" : "Update"}
        </RowButton>
      ) : status.kind === "ready" && confirming ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <RowButton onClick={cancel}>Not now</RowButton>
          <RowButton tone="primary" onClick={() => restart(true)}>
            Restart anyway
          </RowButton>
        </span>
      ) : status.kind === "ready" ? (
        <RowButton tone="primary" onClick={() => restart()}>
          Restart to update
        </RowButton>
      ) : null}
    </div>
  );
}
