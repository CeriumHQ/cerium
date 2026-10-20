import { dataFileUrl } from "@cerium/artifacts";
import type { ProviderId } from "@cerium/protocol";
import { Effect, Schedule } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { Backend, connectionAtom } from "./client.ts";

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
 * A local file an artifact names, and how it is read: an image from anywhere, or a data file under
 * the thread's folder (`root`, at `relative`), whose text is embedded only whole.
 */
export type ArtifactFile =
  | { readonly path: string; readonly kind: "image" }
  | {
      readonly path: string;
      readonly kind: "data";
      readonly mediaType: string;
      readonly root: string;
      readonly relative: string;
    };

const readArtifactFile = (file: ArtifactFile) =>
  file.kind === "image"
    ? Backend.use((client) => client("ReadImage", { path: file.path })).pipe(
        Effect.map(({ mediaType, data }) => `data:${mediaType};base64,${data}`),
      )
    : Backend.use((client) => client("ReadFile", { root: file.root, path: file.relative })).pipe(
        Effect.flatMap((preview) =>
          preview._tag === "Text" && !preview.truncated
            ? Effect.succeed(dataFileUrl(file.mediaType, preview.text))
            : Effect.fail(preview),
        ),
      );

/**
 * The local files an artifact names, as data URLs by path; keyed by the files as JSON. One that
 * can't be read is left out, and the page keeps the path it wrote.
 */
export const artifactFilesAtom = Atom.family(
  (key: string): Atom.Atom<AsyncResult.AsyncResult<ReadonlyMap<string, string>, unknown>> => {
    const files = JSON.parse(key) as ReadonlyArray<ArtifactFile>;
    return files.length === 0
      ? Atom.make(AsyncResult.success(new Map()))
      : Backend.runtime
          .atom(
            Effect.forEach(
              files,
              (file) =>
                readArtifactFile(file).pipe(
                  Effect.map((url) => [file.path, url] as const),
                  Effect.orElseSucceed(() => undefined),
                ),
              { concurrency: 4 },
            ).pipe(
              Effect.map(
                (read): ReadonlyMap<string, string> => new Map(read.filter((entry) => entry !== undefined)),
              ),
            ),
          )
          .pipe(Atom.setIdleTTL("5 minutes"));
  },
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

/** The artifacts drawn in a project's threads, newest first; read again when refreshed or reconnected. */
export const projectArtifactsAtom = Atom.family((folder: string) =>
  Backend.runtime.atom((get) => {
    get(connectionAtom);
    return Backend.use((client) => client("ListArtifacts", { folder })).pipe(
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 3 }),
    );
  }),
);

/** An artifact drawn as a PNG to keep, in the theme it's given. */
export const renderArtifact = Backend.mutation("RenderArtifact");
