import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { AccountError, type HandedCode, type LinkHandoff } from "@cerium/account";
import { LINK_CALLBACK_PATH, LinkCode, LinkId } from "@cerium/protocol";
import { Effect, Queue, Schema } from "effect";

// How Cerium's sign-in page hands this machine the code that finishes signing in: while it signs in,
// the backend listens on the loopback address, which the page in this computer's browser reaches
// and no other computer's can, so a link someone else started and sent the user never brings their
// account's code back to whoever started it. The page goes back to the relay once it handed over.

const isLinkId = Schema.is(LinkId);
const isCode = Schema.is(LinkCode);

const cantListen = () =>
  new AccountError({ message: "Cerium couldn't wait for your browser on this computer. Try again." });

export const loopbackHandoff: LinkHandoff = {
  listen: ({ callback, returnTo }) =>
    Effect.gen(function* () {
      const codes = yield* Queue.unbounded<HandedCode>();
      let port = callback?.port ?? 0;
      const server = yield* Effect.acquireRelease(
        Effect.callback<Server, AccountError>((resume) => {
          const server = createServer((request, response) => {
            const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
            const link = url.searchParams.get("link");
            const code = url.searchParams.get("code");
            // Only the page, sent here by a browser on this computer, has any business here.
            if (
              request.method !== "GET" ||
              request.headers.host !== `127.0.0.1:${port}` ||
              url.pathname !== LINK_CALLBACK_PATH ||
              !isLinkId(link) ||
              !isCode(code)
            ) {
              response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found.");
              return;
            }
            Queue.offerUnsafe(codes, { link, code });
            response
              .writeHead(302, {
                Location: returnTo(link),
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
              })
              .end();
          });
          server.once("error", () => resume(Effect.fail(cantListen())));
          server.listen(port, "127.0.0.1", () => {
            port = (server.address() as AddressInfo).port;
            resume(Effect.succeed(server));
          });
        }),
        (server) =>
          Effect.sync(() => {
            server.close();
            server.closeAllConnections();
          }),
      );
      server.unref();
      return { callback: { port }, next: Queue.take(codes) };
    }),
};
