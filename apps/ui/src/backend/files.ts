import type { ProviderId } from "@cerium/protocol";
import { Effect } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { Backend } from "./client.ts";

// The user's files as the message box and transcript need them: what `@` and `$` offer, and images.

/** An image file as a data URL, read through the backend. Kept a while after it scrolls away. */
export const imageAtom = Atom.family((path: string) =>
  Backend.runtime
    .atom(
      Backend.use((client) => client("ReadImage", { path })).pipe(
        Effect.map(({ mediaType, data }) => `data:${mediaType};base64,${data}`),
      ),
    )
    .pipe(Atom.setIdleTTL("5 minutes")),
);

/**
 * The local images an artifact names, as data URLs by path; keyed by the paths on separate lines.
 * One that can't be read is left out, and the page keeps the path it wrote.
 */
export const artifactImagesAtom = Atom.family(
  (key: string): Atom.Atom<AsyncResult.AsyncResult<ReadonlyMap<string, string>, unknown>> =>
    key === ""
      ? Atom.make(AsyncResult.success(new Map()))
      : Backend.runtime
          .atom(
            Effect.forEach(
              key.split("\n"),
              (path) =>
                Backend.use((client) => client("ReadImage", { path })).pipe(
                  Effect.map(({ mediaType, data }) => [path, `data:${mediaType};base64,${data}`] as const),
                  Effect.orElseSucceed(() => undefined),
                ),
              { concurrency: 4 },
            ).pipe(
              Effect.map(
                (read): ReadonlyMap<string, string> => new Map(read.filter((entry) => entry !== undefined)),
              ),
            ),
          )
          .pipe(Atom.setIdleTTL("5 minutes")),
);

/** Files and folders matching a query; keyed `cwd` and query on separate lines. */
export const workspaceSearchAtom = Atom.family((key: string) => {
  const [cwd = "", ...rest] = key.split("\n");
  return Backend.runtime.atom(
    Backend.use((client) => client("SearchWorkspace", { cwd, query: rest.join("\n") })),
  );
});

export const workspaceSearchKey = (cwd: string, query: string) => `${cwd}\n${query}`;

/** The skills a provider's harness offers in a folder; keyed `provider` and folder on separate lines. */
export const skillsAtom = Atom.family((key: string) => {
  const [provider, cwd = ""] = key.split("\n") as [ProviderId, string?];
  return Backend.runtime
    .atom(Backend.use((client) => client("ListSkills", { provider, ...(cwd === "" ? {} : { cwd }) })))
    .pipe(Atom.setIdleTTL("1 minute"));
});

export const skillsKey = (provider: ProviderId, cwd: string | undefined) => `${provider}\n${cwd ?? ""}`;

export const saveAttachment = Backend.mutation("SaveAttachment");

/** An artifact drawn as a PNG to keep, in the theme it's given. */
export const renderArtifact = Backend.mutation("RenderArtifact");
