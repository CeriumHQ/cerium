import { Account, openTunnel } from "@cerium/account";
import { DeviceId } from "@cerium/protocol";
import { MachineRpcs, TUNNEL_HELLO, MEDIA_RANGE_RPC_VERSION } from "@cerium/rpc";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { Effect, Layer, Option, Schema, Stream } from "effect";
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
    if (length === 0 || size === 0) return { _tag: "Unsatisfiable" };
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
  const remote = query.get("machine");
  if (remote !== null) {
    const id = Schema.decodeUnknownOption(DeviceId)(remote);
    if (Option.isNone(id)) return HttpServerResponse.empty({ status: 400 });
    const account = yield* Account;
    const state = Option.getOrUndefined(yield* Stream.runHead(account.changes));
    if (
      state?._tag !== "SignedIn" ||
      !state.devices.some(
        (d) => d.id === id.value && d.online && (d.rpcVersion ?? 0) >= MEDIA_RANGE_RPC_VERSION,
      )
    )
      return HttpServerResponse.empty({ status: 503 });
    // Bind the RPC client and its tunnel to the HTTP request (including its streaming body).
    const transport = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        Layer.effect(
          Socket.Socket,
          Socket.fromWebSocket(openTunnel(account, id.value, { hello: TUNNEL_HELLO })),
        ),
      ),
      Layer.provide(RpcSerialization.layerJson),
    );
    const protocol = yield* Layer.build(transport);
    const client = yield* RpcClient.make(MachineRpcs).pipe(Effect.provide(protocol));
    const file = yield* client.ReadFile({ root, path }).pipe(Effect.option);
    if (Option.isNone(file) || file.value._tag !== "Media") return HttpServerResponse.empty({ status: 404 });
    const { size, mediaType } = file.value;
    const range = byteRange(request.headers["range"], size);
    const headers = { "accept-ranges": "bytes", "cache-control": "no-store" };
    if (range._tag === "Unsatisfiable")
      return HttpServerResponse.empty({
        status: 416,
        headers: { ...headers, "content-range": `bytes */${size}` },
      });
    const part =
      range._tag === "Part" ? { offset: range.start, length: range.end - range.start + 1 } : undefined;
    const body = client
      .ReadFileBytes({ root, path, ...(part ? { range: part } : {}) })
      .pipe(Stream.map(({ data }) => Buffer.from(data, "base64")));
    return HttpServerResponse.stream(body, {
      status: part ? 206 : 200,
      contentType: mediaType,
      contentLength: part?.length ?? size,
      headers: {
        ...headers,
        ...(range._tag === "Part" ? { "content-range": `bytes ${range.start}-${range.end}/${size}` } : {}),
      },
    });
  }
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
