import { compareVersions, parseVersion } from "@cerium/harness";
import { Cache, Context, Effect, Exit, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

// The newest release of each harness, and of `gh`, so Settings can say when one is out. Cerium reads
// the version its makers publish and nothing else: npm's `latest` tag, or a GitHub repository's latest
// release. Each answer is kept for hours, and a lookup that fails counts as nothing newer.

/** Where a program's releases are published. */
export type ReleaseSource =
  | { readonly npm: string }
  /** `owner/name` of a GitHub repository whose releases are tagged `v1.2.3`. */
  | { readonly github: string };

/** How long one lookup may take before it counts as nothing newer. */
const LOOKUP_TIMEOUT = "8 seconds";

const NpmTags = Schema.Struct({ latest: Schema.String });
const GitHubRelease = Schema.Struct({ tag_name: Schema.String });

const keyOf = (source: ReleaseSource) => ("npm" in source ? `npm:${source.npm}` : `github:${source.github}`);

/** The release a key names, read from where it is published; none when it can't be read. */
const urlOf = (key: string) => {
  const [kind, name] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  return kind === "npm"
    ? { url: `https://registry.npmjs.org/-/package/${name}/dist-tags`, schema: "npm" as const }
    : { url: `https://api.github.com/repos/${name}/releases/latest`, schema: "github" as const };
};

/** `installed`'s newer release, when `latest` is one; none when either isn't a version. */
export const newerRelease = (installed: string, latest: string | undefined): string | undefined =>
  latest !== undefined &&
  parseVersion(installed) !== undefined &&
  parseVersion(latest) !== undefined &&
  compareVersions(latest, installed) > 0
    ? latest
    : undefined;

export class Releases extends Context.Service<
  Releases,
  {
    /** The newest release published at `source`, when it can be read. */
    latest(source: ReleaseSource): Effect.Effect<Option.Option<string>>;
  }
>()("cerium/backend/Releases") {
  /** Requires an `HttpClient`. */
  static readonly layer = Layer.effect(
    Releases,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const lookup = (key: string) =>
        Effect.gen(function* () {
          const { url, schema } = urlOf(key);
          const response = yield* client.execute(
            HttpClientRequest.get(url).pipe(
              HttpClientRequest.setHeader("accept", "application/json"),
              HttpClientRequest.setHeader("user-agent", "Cerium"),
            ),
          );
          if (response.status !== 200) return Option.none<string>();
          const body = yield* response.json;
          const version =
            schema === "npm"
              ? (yield* Schema.decodeUnknownEffect(NpmTags)(body)).latest
              : (yield* Schema.decodeUnknownEffect(GitHubRelease)(body)).tag_name.replace(/^v/, "");
          return version === "" ? Option.none<string>() : Option.some(version);
        }).pipe(
          Effect.timeout(LOOKUP_TIMEOUT),
          Effect.orElseSucceed(() => Option.none<string>()),
        );
      const releases = yield* Cache.makeWith(lookup, {
        capacity: 32,
        // A release comes out every few days; a lookup that failed is tried again on a later check.
        timeToLive: (exit) => (Exit.isSuccess(exit) && Option.isSome(exit.value) ? "6 hours" : "10 minutes"),
      });
      return Releases.of({ latest: (source) => Cache.get(releases, keyOf(source)) });
    }),
  );
}
