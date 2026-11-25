import {
  OFFERED_PROVIDERS,
  type AccountState,
  type AccountThreads,
  type AgentEvent,
  type Settings,
  type ThreadId,
} from "@cerium/protocol";
import { type ThreadOverview } from "@cerium/rpc";
import { RegistryContext, useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent, useState } from "react";

import {
  accountAtom,
  accountThreadsAtom,
  cloudEventsAtom,
  cloudFileChangesAtom,
  fileChangesAtom,
  harnessesAtom,
  importedThreadsAtom,
  markThreadsRead,
  settingsAtom,
  summaryEventsAtom,
  threadsAtom,
} from "../backend/atoms.ts";
import { connectionAtom } from "../backend/client.ts";
import { driveMachine, machineToDrive } from "../backend/machine.ts";
import { WEB } from "../backend/target.ts";
import { toAgentSummaries, toThreadSummary } from "../backend/view.ts";
import { reachOf } from "../features/account/model.ts";
import { isNewDraftKey } from "../features/composer/drafts.ts";
import { useModels } from "../features/composer/models.ts";
import { type Lineage } from "../features/git/WorkspaceStatus.tsx";
import { useReadState } from "../features/threads/readState.ts";
import { type ThreadSummary } from "../features/threads/model.ts";
import { type HarnessIndicator } from "../features/threads/Sidebar.tsx";
import { isNonThreadKey } from "../features/tabs/tabKinds.ts";
import { useMatchingBuild } from "../web/builds.ts";
import { cachedThreads, cachedThreadsOf, useThreadsCache } from "../web/cache.ts";
import { tappedMachine } from "../web/push.ts";
import { useLaunched } from "./launch.ts";
import { useBackendFailure } from "../features/crash/BackendFailureNotice.tsx";
import { threadWindowOpener } from "./threadWindow.ts";

import type { DrivenMachine } from "../backend/machine.ts";
import type { SoloThread } from "./threadWindow.ts";

const noEvents = Atom.make(AsyncResult.success<Array<AgentEvent>>([]));
/** One value for no threads, so a render without the relay's can tell it from one with them. */
const noThreads: AccountThreads = { threads: [], read: [] };

export function useWorkspaceThreads({
  driven,
  solo,
  active,
  filesOpen,
}: {
  readonly driven: DrivenMachine | undefined;
  readonly solo: SoloThread | undefined;
  readonly active: string | undefined;
  readonly filesOpen: boolean;
}) {
  const registry = useContext(RegistryContext);
  const connection = useAtomValue(connectionAtom);
  const backendFailure = useBackendFailure();
  const threadsResult = useAtomValue(threadsAtom);
  const refreshThreads = useAtomRefresh(threadsAtom);
  const harnessesResult = useAtomValue(harnessesAtom);
  const harnesses = AsyncResult.getOrElse(harnessesResult, () => []);
  const disabledProviders = AsyncResult.getOrElse(
    useAtomValue(settingsAtom),
    (): Pick<Settings, "disabledProviders"> => ({ disabledProviders: [] }),
  ).disabledProviders;
  const models = useModels();
  // Another machine that can't be reached shows the threads it last listed no more: they read from
  // the cloud copy instead, until it answers again. This computer's own list stays while it reconnects.
  const live =
    AsyncResult.isSuccess(threadsResult) && !(connection === "unreachable" && driven !== undefined);
  const overviews: ReadonlyArray<ThreadOverview> = live
    ? AsyncResult.getOrElse(threadsResult, () => [])
    : driven === undefined
      ? // A list call that fails while the backend restarts keeps the last list it gave.
        Option.getOrElse(AsyncResult.value(threadsResult), () => [])
      : [];
  const accountResult = useAtomValue(accountAtom);
  const account = AsyncResult.getOrElse(accountResult, (): AccountState => ({
    _tag: "SignedOut",
  }));
  const relayThreads = AsyncResult.getOrElse(useAtomValue(accountThreadsAtom), () => noThreads);
  // The web client shows the threads it kept last time until the relay's arrive: the atom's first
  // value is its empty stand-in, and anything after it, or anything at all, is the relay's.
  const [standIn] = useState(relayThreads);
  const heard = relayThreads !== standIn || standIn.threads.length > 0 || standIn.read.length > 0;
  const [kept] = useState(() => (WEB ? cachedThreads() : undefined));
  const cached = heard ? undefined : cachedThreadsOf(kept, account);
  const accountThreads = cached?.threads ?? relayThreads;
  useThreadsCache({
    enabled: WEB,
    account,
    accountKnown: AsyncResult.isSuccess(accountResult),
    heard,
    threads: relayThreads,
  });
  // Every thread of the account: the driven machine's live, the others' from the cloud copy.
  const devices = account._tag === "SignedIn" ? account.devices : [];
  const thisComputer = account._tag === "SignedIn" ? account.deviceId : undefined;
  const drivenId = driven?.id ?? thisComputer;
  const deviceOf = (id: string) => devices.find((device) => device.id === id);
  const nameOf = (id: string) =>
    deviceOf(id)?.name ??
    cachedThreadsOf(kept, account)?.devices.find((device) => device.id === id)?.name ??
    "another computer";
  // Until the driven machine answers, or while it can't, its threads read from the copy too.
  const elsewhere = accountThreads.threads.filter(
    (each) =>
      drivenId !== undefined &&
      (each.machine !== drivenId || !live) &&
      !overviews.some((overview) => overview.thread.id === each.overview.thread.id),
  );
  /** The thread `key` names: live from the driven machine, or another machine's from the cloud copy. */
  const resolve = (key: string | undefined) => {
    const listed = overviews.find((overview) => overview.thread.id === key);
    /** Another machine's thread open from the cloud copy, read-only, while that machine can't be reached. */
    const cloud = listed ? undefined : elsewhere.find((each) => each.overview.thread.id === key);
    const shown = listed ?? cloud?.overview;
    /**
     * The thread isn't listed yet because the list hasn't loaded (just after a reload): it holds
     * its place rather than showing the blank new thread, whose draft the user would be writing in.
     */
    const loading =
      shown === undefined &&
      key !== undefined &&
      !isNewDraftKey(key) &&
      overviews.length === 0 &&
      !AsyncResult.isSuccess(threadsResult);
    return { listed, cloud, shown, loading };
  };
  // A thread's own window is its thread's, whichever of its panes has the focus.
  const { listed: selected, cloud: cloudSelected, shown: viewed } = resolve(solo?.id ?? active);
  const share = useAtomSet(markThreadsRead, { mode: "promise" });
  const readState = useReadState(
    new Map(accountThreads.read.map((entry) => [entry.threadId as string, entry.seenAt])),
    account._tag === "SignedIn"
      ? (entries) =>
          void share({
            payload: {
              entries: entries.map((entry) => ({ ...entry, threadId: entry.threadId as ThreadId })),
            },
          }).catch(() => undefined)
      : undefined,
  );
  // Threads just brought in from the harnesses arrive with their own past activity, which isn't news.
  const [imported, setImported] = useAtom(importedThreadsAtom);
  const markImported = useEffectEvent(() => {
    readState.markRead(imported);
    setImported([]);
  });
  useEffect(() => {
    if (imported.length > 0) markImported();
  }, [imported]);
  /** The open thread, when it was unread as the user opened it: it keeps its inbox place until they leave. */
  const [heldUnread, setHeldUnread] = useState<string>();
  const here = overviews
    .map(toThreadSummary)
    .map((summary) => (driven ? { ...summary, machine: driven.name } : summary));
  const there = elsewhere.map((each) => {
    const summary = toThreadSummary(each.overview);
    const online = deviceOf(each.machine)?.online === true;
    return {
      ...summary,
      // An offline machine's agents aren't working, whatever they were doing when it went.
      ...(online || summary.status === "failed" ? {} : { status: "idle" as const }),
      ...(each.machine === thisComputer ? {} : { machine: nameOf(each.machine) }),
      elsewhere: { machine: each.machine, online },
    };
  });
  /**
   * Threads being archived or deleted, with when: the list shows them gone at once while their
   * agents end and their worktree goes, and puts them back if that fails.
   */
  const [puttingAway, setPuttingAway] = useState<
    ReadonlyMap<string, { readonly deleting: boolean; readonly at: number; readonly done?: true }>
  >(new Map());
  /** Marks a thread put away (it goes once the list agrees), or shows it again when that failed. */
  const settlePutAway = (threadId: string, done: boolean) =>
    setPuttingAway((all) => {
      const next = new Map(all);
      const away = next.get(threadId);
      if (done && away !== undefined) next.set(threadId, { ...away, done: true });
      else next.delete(threadId);
      return next;
    });
  const caughtUp = [...puttingAway].filter(([threadId, away]) => {
    if (away.done !== true) return false;
    const listed = [...here, ...there].find((summary) => summary.id === threadId);
    return away.deleting ? listed === undefined : listed?.archivedAt !== undefined;
  });
  if (caughtUp.length > 0) {
    setPuttingAway(
      (all) => new Map([...all].filter(([threadId]) => !caughtUp.some(([id]) => id === threadId))),
    );
  }
  // A work thread is unread once it changed after the user last saw it; the open one is seen as it changes.
  const summaries = [...here, ...there].flatMap((summary) => {
    const away = puttingAway.get(summary.id);
    if (away?.deleting === true) return [];
    const shown = away === undefined ? summary : { ...summary, archivedAt: away.at };
    return [
      shown.mode !== "work"
        ? shown
        : shown.id === viewed?.thread.id
          ? { ...shown, unread: shown.id === heldUnread }
          : { ...shown, unread: readState.isUnread(shown.id, shown.updatedAt) },
    ];
  });
  const selectedSummary = summaries.find((summary) => summary.id === viewed?.thread.id);
  /**
   * Opens one of this computer's threads in a window of its own (threadWindow.ts): offered by the
   * desktop's main window while it shows this computer.
   */
  const threadWindow = driven === undefined ? threadWindowOpener() : undefined;
  const openInWindow =
    threadWindow === undefined
      ? undefined
      : (threadId: string) => {
          const summary = summaries.find((each) => each.id === threadId && each.elsewhere === undefined);
          if (summary) threadWindow(summary.id, summary.mode);
        };
  const drivenDevice =
    driven === undefined || account._tag !== "SignedIn"
      ? undefined
      : account.devices.find((device) => device.id === driven.id);
  // The web client runs the build of the desktop it drives, and takes the open thread there.
  useMatchingBuild(drivenDevice, isNewDraftKey(active) || isNonThreadKey(active) ? undefined : active);
  // The web client always drives one of the account's desktops: the one a tapped notification is
  // about, else the one it drove last, else the first that can be reached, once one can.
  const reachable = devices.filter(
    (device) => device.kind === "desktop" && reachOf(device).kind === "reachable",
  );
  const tapped = tappedMachine();
  const tappedDevice = reachable.find((device) => device.id === tapped);
  const toDrive =
    WEB && driven === undefined
      ? tappedDevice
        ? { id: tappedDevice.id, name: tappedDevice.name }
        : machineToDrive(reachable)
      : undefined;
  const driveChosen = useEffectEvent(() => {
    if (toDrive !== undefined) driveMachine(registry, toDrive);
  });
  useEffect(() => driveChosen(), [toDrive?.id]);
  // The window shows once it has its threads, or has no machine to list them from yet; one that
  // can't be reached shows its notice instead. The web client shows as soon as it knows the
  // account: its threads, kept from last time or the cloud copy's, show while the machine connects.
  useLaunched(
    connection === "unreachable" ||
      backendFailure !== undefined ||
      (AsyncResult.isSuccess(accountResult) && (WEB || AsyncResult.isSuccess(threadsResult))),
  );
  // A thread's own window closes once its thread is gone, deleted from here or from the main window.
  const soloGone =
    solo !== undefined && live && !overviews.some((overview) => overview.thread.id === solo.id);
  useEffect(() => {
    if (soloGone) window.close();
  }, [soloGone]);
  const markSeen = useEffectEvent(() => {
    if (selectedSummary && readState.isUnread(selectedSummary.id, selectedSummary.updatedAt)) {
      readState.markRead([selectedSummary]);
    }
  });
  useEffect(() => markSeen(), [selectedSummary?.id, selectedSummary?.updatedAt]);
  // What the window reads of the open thread's events: live from the driven machine, or the cloud
  // copy of another machine's. Only the kinds its agents and artifacts are worked out from, and the
  // files changed while the files panel lists them: its pane renders the conversation, and the window
  // doesn't render again for every tool call or streamed word.
  const cloudEvents = cloudSelected
    ? cloudEventsAtom(`${cloudSelected.machine}:${cloudSelected.overview.thread.id}`)
    : noEvents;
  const eventsAtom: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<AgentEvent>, unknown>> = selected
    ? summaryEventsAtom(selected.thread.id)
    : cloudEvents;
  const events = AsyncResult.getOrElse(useAtomValue(eventsAtom), (): ReadonlyArray<AgentEvent> => []);
  const fileEventsAtom: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<AgentEvent>, unknown>> = !filesOpen
    ? noEvents
    : selected
      ? fileChangesAtom(selected.thread.id)
      : cloudSelected
        ? cloudFileChangesAtom(`${cloudSelected.machine}:${cloudSelected.overview.thread.id}`)
        : noEvents;
  const fileEvents = AsyncResult.getOrElse(useAtomValue(fileEventsAtom), (): ReadonlyArray<AgentEvent> => []);
  /** Opens another machine's thread there: the window drives that machine, then shows it. */
  const reachableHome = (summary: ThreadSummary) => {
    const home = summary.elsewhere ? deviceOf(summary.elsewhere.machine) : undefined;
    return home && home.id !== drivenId && (home.id === thisComputer || reachOf(home).kind === "reachable")
      ? home
      : undefined;
  };
  const indicators: ReadonlyArray<HarnessIndicator> = OFFERED_PROVIDERS.map((provider) => {
    const status = harnesses.find((candidate) => candidate.provider === provider);
    if (status === undefined) return { provider, state: "unsupported" };
    if (status._tag === "HarnessMissing") return { provider, state: "missing" };
    // Turned off by the user, so it isn't offered, nor nagged about while signed out.
    if (disabledProviders.includes(provider)) return { provider, state: "disabled" };
    if (status.auth._tag === "LoggedOut") return { provider, state: "loggedOut" };
    return { provider, state: "ready", ...(status.setup ? { needsSetup: true } : {}) };
  });
  const available = new Set(
    indicators.flatMap(({ provider, state }) => (state === "ready" ? [provider] : [])),
  );
  /** The harnesses have answered and none can run a thread: there is nothing to start one with. */
  const noHarness = AsyncResult.isSuccess(harnessesResult) && available.size === 0;

  const agents = viewed ? toAgentSummaries(viewed.agents, events, models) : [];
  /** Who a thread was forked from and who was forked from it, among the threads listed here. */
  const lineageOf = (threadId: string, forkedFrom: { readonly threadId: string } | undefined): Lineage => ({
    ...(forkedFrom === undefined
      ? {}
      : {
          parent: {
            id: forkedFrom.threadId,
            title: overviews.find(({ thread }) => thread.id === forkedFrom.threadId)?.thread.title,
          },
        }),
    forks: overviews
      .filter(({ thread }) => thread.forkedFrom?.threadId === threadId)
      .map(({ thread }) => ({ id: thread.id, title: thread.title })),
  });

  const lineage = viewed === undefined ? undefined : lineageOf(viewed.thread.id, viewed.thread.forkedFrom);
  const projectOf = (folder: string) =>
    overviews.find((overview) => overview.thread.cwd === folder)?.thread.worktree?.project ?? folder;

  const markRead = (threads: Parameters<typeof readState.markRead>[0]) => {
    if (threads.some((thread) => thread.id === heldUnread)) setHeldUnread(undefined);
    readState.markRead(threads);
  };
  const markUnread = (threadId: string) => {
    if (threadId === viewed?.thread.id) setHeldUnread(threadId);
    readState.markUnread(threadId);
  };

  const beginPutAway = (threadId: string, deleting: boolean, done = false) =>
    setPuttingAway((all) =>
      new Map(all).set(threadId, { deleting, at: Date.now(), ...(done ? { done: true } : {}) }),
    );
  const undoPutAway = (threadId: string) => {
    const away = puttingAway.get(threadId);
    return () => {
      if (away === undefined) return;
      setPuttingAway((all) => {
        if (all.get(threadId) !== away) return all;
        const next = new Map(all);
        next.delete(threadId);
        return next;
      });
    };
  };

  return {
    connection,
    backendFailure,
    threadsResult,
    refreshThreads,
    live,
    resolve,
    selected,
    viewed,
    cloudSelected,
    summaries,
    selectedSummary,
    overviews,
    account,
    thisComputer,
    drivenId,
    drivenDevice,
    deviceOf,
    nameOf,
    reachableHome,
    openInWindow,
    setHeldUnread,
    markRead,
    markUnread,
    beginPutAway,
    settlePutAway,
    undoPutAway,
    cloudEvents,
    fileEvents,
    indicators,
    available,
    noHarness,
    agents,
    models,
    lineage,
    projectOf,
  };
}

export type WorkspaceThreads = ReturnType<typeof useWorkspaceThreads>;
