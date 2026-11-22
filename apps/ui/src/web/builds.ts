import type { DeviceInfo } from "@cerium/protocol";
import { MIN_RPC_VERSION, RPC_VERSION } from "@cerium/rpc";
import { useEffect } from "react";

import { BUILD_VERSION, WEB } from "../backend/target.ts";
import { OPEN_PARAMS } from "./serviceWorker.ts";

// The web client runs a build that speaks to the desktop it drives. The relay serves every
// version's build under `/v/<version>/`, the newest at `/app/` too, and lists them in
// `/v/builds.json`. A build reads every backend from `MIN_RPC_VERSION` up to its own `RPC_VERSION`,
// as a desktop's UI does driving another computer, so a browser stays on the build it loaded unless
// the desktop is newer than it can read; then it moves to that version's build. A version the relay
// doesn't keep stays on this build, which reads what it can.

/** The address Cerium opened at, before it tidies it: a tapped notification's thread rides in it. */
const launchQuery = new URLSearchParams(typeof location === "undefined" ? "" : location.search);

let available: Promise<ReadonlySet<string>> | undefined;

/** The versions `/v/builds.json` lists. */
const listedVersions = (listed: unknown): ReadonlySet<string> => {
  const versions =
    typeof listed === "object" && listed !== null && "versions" in listed ? listed.versions : [];
  return new Set(Array.isArray(versions) ? versions.filter((each) => typeof each === "string") : []);
};

/** The versions whose builds the relay serves; none when it can't say, as under the dev server. */
const availableBuilds = () =>
  (available ??= fetch("/v/builds.json", { cache: "no-store" })
    .then((response): Promise<unknown> | undefined => (response.ok ? response.json() : undefined))
    .then(listedVersions)
    .catch(() => new Set<string>()));

/** What a build is: its release, and the RPC version it speaks. */
export interface Build {
  readonly version: string;
  readonly rpcVersion: number;
}

/** This page's build. */
const thisBuild: Build = { version: BUILD_VERSION, rpcVersion: RPC_VERSION };

/**
 * The version whose build the web client should move to, to drive `driven`: none when it's this
 * build's, or one this build already reads. A desktop that doesn't say what it speaks moves it.
 */
export const buildToMoveTo = (
  driven: Pick<DeviceInfo, "version" | "rpcVersion"> | undefined,
  current: Build = thisBuild,
): string | undefined => {
  if (driven === undefined || driven.version === current.version) return undefined;
  const { rpcVersion } = driven;
  const readable =
    rpcVersion !== undefined && rpcVersion >= MIN_RPC_VERSION && rpcVersion <= current.rpcVersion;
  return readable ? undefined : driven.version;
};

/**
 * Where the build of `version` opens: on `thread` of `machine`, or the thread and machine a tapped
 * notification opened Cerium for.
 */
export const buildAddress = (
  version: string,
  opening: { readonly thread?: string | undefined; readonly machine?: string | undefined } = {},
  launched: URLSearchParams = launchQuery,
) => {
  // A thread and its machine go together: the open one's, or else the tapped one's.
  const [thread, machine] =
    opening.thread === undefined
      ? [launched.get(OPEN_PARAMS.thread) ?? undefined, launched.get(OPEN_PARAMS.machine) ?? undefined]
      : [opening.thread, opening.machine];
  const query = new URLSearchParams();
  if (thread !== undefined) {
    if (machine !== undefined) query.set(OPEN_PARAMS.machine, machine);
    query.set(OPEN_PARAMS.thread, thread);
  }
  const search = query.toString();
  return `/v/${encodeURIComponent(version)}/${search === "" ? "" : `?${search}`}`;
};

/**
 * Moves the web client to the build of the desktop it drives, when this one can't read it and the
 * relay serves that version, opening `thread` there. Driving a desktop that updates moves it too.
 */
export function useMatchingBuild(driven: DeviceInfo | undefined, thread: string | undefined) {
  const moving = WEB ? buildToMoveTo(driven) : undefined;
  const machine = driven?.id;
  useEffect(() => {
    if (moving === undefined) return;
    let current = true;
    void availableBuilds().then((versions) => {
      if (current && versions.has(moving)) location.replace(buildAddress(moving, { thread, machine }));
    });
    return () => {
      current = false;
    };
  }, [moving, thread, machine]);
}
