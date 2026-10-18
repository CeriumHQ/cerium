import type { DeviceInfo } from "@cerium/protocol";
import { useEffect } from "react";

import { BUILD_VERSION, WEB } from "../backend/target.ts";
import { OPEN_PARAMS } from "./serviceWorker.ts";

// The web client runs the build of the desktop it drives (docs/architecture.md §14.10). The relay
// serves every version's build under `/v/<version>/`, the newest at its root too, and lists them in
// `/v/builds.json`; a browser driving a desktop of another version moves to that version's build, so
// the UI and the backend it talks to always come from the same release. A version the relay doesn't
// keep stays on this build, which reads what it can (§14.1).

/** The address Cerium opened at, before it tidies it: a tapped notification's thread rides in it. */
const launchQuery = new URLSearchParams(location.search);

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

/** Where the build of `version` opens with `thread`, or the thread a tap opened Cerium for. */
export const buildAddress = (version: string, thread: string | undefined) => {
  const opening = thread ?? launchQuery.get(OPEN_PARAMS.thread) ?? undefined;
  const query = opening === undefined ? "" : `?${new URLSearchParams({ [OPEN_PARAMS.thread]: opening })}`;
  return `/v/${encodeURIComponent(version)}/${query}`;
};

/**
 * Moves the web client to the build of the desktop it drives, when that's another version the relay
 * serves, opening `thread` there. Driving a desktop that updates moves it too.
 */
export function useMatchingBuild(driven: DeviceInfo | undefined, thread: string | undefined) {
  const version = WEB ? driven?.version : undefined;
  const moving = version !== undefined && version !== BUILD_VERSION ? version : undefined;
  useEffect(() => {
    if (moving === undefined) return;
    let current = true;
    void availableBuilds().then((versions) => {
      if (current && versions.has(moving)) location.replace(buildAddress(moving, thread));
    });
    return () => {
      current = false;
    };
  }, [moving, thread]);
}
