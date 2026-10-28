import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { Files } from "./files.ts";

// A media file the viewer shows, served straight to the page's `<video>`, `<audio>` or `<img>` in the
// byte ranges it asks for, so playback starts once its first pieces arrive and seeking skips ahead,
// instead of the whole file going over the RPC socket as base64 before anything plays.

export const MEDIA_PATH = "/media";

/** The bytes a `Range` header asks of a file of `size` bytes, both ends included. */
export type ByteRange =
  | { readonly _tag: "Whole" }
  | { readonly _tag: "Part"; readonly start: number; readonly end: number }
  | { readonly _tag: "Unsatisfiable" };

/**
 * What a `Range` header asks for. Only one range is served: a header asking for several, or one
 * this can't read, gets the whole file, as HTTP allows.
 */
export const byteRange = (header: string | undefined, size: number): ByteRange => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (match === null) return { _tag: "Whole" };
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") return { _tag: "Whole" };
  if (from === "") {
    // The last `to` bytes.
    const length = Number(to);
    if (length === 0) return { _tag: "Unsatisfiable" };
    return { _tag: "Part", start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(from);
  if (start >= size) return { _tag: "Unsatisfiable" };
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  return end < start ? { _tag: "Whole" } : { _tag: "Part", start, end };
};

const serve = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const query = new URL(request.url, "http://localhost").searchParams;
  const root = query.get("root");
  const path = query.get("path");
  if (root === null || path === null) return HttpServerResponse.empty({ status: 400 });
  const files = yield* Files;
  const found = yield* files.media(root, path).pipe(Effect.result);
  if (found._tag === "Failure") return HttpServerResponse.text(found.failure.message, { status: 404 });
  const { target, size, mediaType } = found.success;
  const range = byteRange(request.headers["range"], size);
  const headers = { "accept-ranges": "bytes", "cache-control": "no-store" };
  if (range._tag === "Unsatisfiable") {
    return HttpServerResponse.empty({
      status: 416,
      headers: { ...headers, "content-range": `bytes */${size}` },
    });
  }
  return yield* (
    range._tag === "Whole"
      ? HttpServerResponse.file(target, { contentType: mediaType, headers })
      : HttpServerResponse.file(target, {
          status: 206,
          contentType: mediaType,
          offset: range.start,
          bytesToRead: range.end - range.start + 1,
          headers: { ...headers, "content-range": `bytes ${range.start}-${range.end}/${size}` },
        })
  ).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 404 }))));
});

/** Serves media files to the UI holding this launch's token. Requires `Files` and an `HttpRouter`. */
export const mediaRoutes = (requireToken: Layer.Layer<never>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      yield* router.add("GET", MEDIA_PATH, serve);
    }),
  ).pipe(Layer.provide(requireToken));
