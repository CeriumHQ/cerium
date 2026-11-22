import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import {
  ASSET_CACHE,
  OPEN_MESSAGE,
  requestKind,
  serviceWorker,
  SHELL_CACHE,
  SHELL_WAIT_MS,
  shellKey,
  type ServiceWorkerScope,
  type WorkerCache,
} from "../src/web/serviceWorker.ts";

const ORIGIN = "https://cerium.example";

const keyOf = (request: Request | string) => (typeof request === "string" ? request : request.url);

/** A cache in memory, keyed by URL in the order entries went in, as the Cache API keeps them. */
const memoryCache = (): WorkerCache & { readonly entries: Map<string, Response> } => {
  const entries = new Map<string, Response>();
  return {
    entries,
    match: async (request) => entries.get(keyOf(request))?.clone(),
    put: async (request, response) => {
      entries.delete(keyOf(request));
      entries.set(keyOf(request), response);
    },
    keys: async () => [...entries.keys()].map((url) => new Request(url)),
    delete: async (request) => entries.delete(keyOf(request)),
  };
};

type Listener = (event: never) => void;

const setup = (fetcher: (request: Request | string) => Promise<Response>) => {
  const listeners = new Map<string, Listener>();
  const caches = new Map<string, ReturnType<typeof memoryCache>>();
  const notifications: Array<{ title: string; options: unknown }> = [];
  const badges: Array<number | "cleared"> = [];
  const windows: Array<{ url: string; messages: Array<unknown>; focused: number }> = [];
  const opened: Array<string> = [];
  const cache = (name: string) => {
    let found = caches.get(name);
    if (found === undefined) caches.set(name, (found = memoryCache()));
    return found;
  };
  const scope: ServiceWorkerScope = {
    location: { origin: ORIGIN },
    registration: {
      showNotification: async (title, options) => void notifications.push({ title, options }),
      getNotifications: async () => notifications,
    },
    clients: {
      matchAll: async () =>
        windows.map((each) => ({
          url: each.url,
          focus: async function () {
            each.focused++;
            return this;
          },
          postMessage: (message: unknown) => void each.messages.push(message),
        })),
      openWindow: async (url) => {
        opened.push(url);
        return null;
      },
      claim: async () => undefined,
    },
    caches: {
      open: async (name) => cache(name),
      keys: async () => [...caches.keys()],
      delete: async (name) => caches.delete(name),
    },
    navigator: {
      setAppBadge: async (count) => void badges.push(count ?? 0),
      clearAppBadge: async () => void badges.push("cleared"),
    },
    fetch: fetcher,
    skipWaiting: async () => undefined,
    addEventListener: (type: string, listener: Listener) => void listeners.set(type, listener),
  } as ServiceWorkerScope;
  serviceWorker(scope);

  /** Dispatches an event, and waits for everything it asked to wait for. */
  const dispatch = async (type: string, event: object) => {
    const waits: Array<Promise<unknown>> = [];
    let response: Promise<Response> | undefined;
    listeners.get(type)!({
      ...event,
      waitUntil: (promise: Promise<unknown>) => void waits.push(promise),
      respondWith: (promise: Promise<Response>) => void (response = promise),
    } as never);
    const answered = await response;
    await Promise.all(waits);
    return answered;
  };
  const get = (path: string) => dispatch("fetch", { request: new Request(`${ORIGIN}${path}`) });
  return { dispatch, get, cache, caches, notifications, badges, windows, opened };
};

const page = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html" } });

describe("what the service worker handles", () => {
  const kind = (path: string, origin = ORIGIN) => requestKind(new URL(path, origin), ORIGIN);

  it("keeps a version's files and the app's pages, and nothing of the relay's API", () => {
    expect(kind("/v/1.2.3/assets/index-abc.js")).toBe("asset");
    expect(kind("/app/")).toBe("shell");
    expect(kind("/app/index.html")).toBe("shell");
    expect(kind("/v/1.2.3/")).toBe("shell");
    expect(kind("/v/1.2.3/?machine=desk&thread=thr")).toBe("shell");
    expect(kind("/api/connect")).toBeUndefined();
    expect(kind("/api/v/1/assets/x.js")).toBeUndefined();
    expect(kind("/v/builds.json")).toBeUndefined();
    expect(kind("/sw.js")).toBeUndefined();
    expect(kind("/")).toBeUndefined();
    expect(kind("/v/1.2.3/assets/x.js", "https://elsewhere.example")).toBeUndefined();
  });

  it("keeps a page under its folder, whatever its address carries", () => {
    expect(shellKey(new URL(`${ORIGIN}/app/?machine=desk&thread=thr`))).toBe(`${ORIGIN}/app/`);
    expect(shellKey(new URL(`${ORIGIN}/v/1.2.3/index.html`))).toBe(`${ORIGIN}/v/1.2.3/`);
  });
});

describe("the service worker's caches", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves a version's files from the cache once fetched", async () => {
    const fetcher = vi.fn<(request: Request | string) => Promise<Response>>(async () => new Response("code"));
    const worker = setup(fetcher);
    expect(await (await worker.get("/v/1/assets/a.js"))!.text()).toBe("code");
    expect(await (await worker.get("/v/1/assets/a.js"))!.text()).toBe("code");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps no file the relay refused", async () => {
    const fetcher = vi.fn<(request: Request | string) => Promise<Response>>(
      async () => new Response("missing", { status: 404 }),
    );
    const worker = setup(fetcher);
    await worker.get("/v/1/assets/a.js");
    await worker.get("/v/1/assets/a.js");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(worker.cache(ASSET_CACHE).entries.size).toBe(0);
  });

  it("leaves the relay's API alone", async () => {
    const worker = setup(async () => new Response("{}"));
    expect(await worker.get("/api/config")).toBeUndefined();
    expect(worker.caches.size).toBe(0);
  });

  it("serves the app's page from the relay, keeping it for next time", async () => {
    const worker = setup(async () => page("fresh"));
    expect(await (await worker.get("/app/?thread=thr"))!.text()).toBe("fresh");
    expect([...worker.cache(SHELL_CACHE).entries.keys()]).toEqual([`${ORIGIN}/app/`]);
  });

  it("serves the kept page when the relay can't be reached, or fails", async () => {
    let answer: () => Promise<Response> = async () => page("first");
    const worker = setup(() => answer());
    await worker.get("/app/");
    answer = () => Promise.reject(new TypeError("offline"));
    expect(await (await worker.get("/app/"))!.text()).toBe("first");
    answer = async () => page("down", 503);
    expect(await (await worker.get("/app/"))!.text()).toBe("first");
  });

  it("serves the kept page when the relay is slow, and keeps the late one for next time", async () => {
    let answer: () => Promise<Response> = async () => page("first");
    const worker = setup(() => answer());
    await worker.get("/app/");
    let arrive: (response: Response) => void = () => undefined;
    answer = () => new Promise((resolve) => (arrive = resolve));
    const served = worker.get("/app/");
    await vi.advanceTimersByTimeAsync(SHELL_WAIT_MS);
    arrive(page("second"));
    expect(await (await served)!.text()).toBe("first");
    expect(await (await worker.cache(SHELL_CACHE).match(`${ORIGIN}/app/`))!.text()).toBe("second");
  });

  it("drops an earlier worker's caches as it takes over", async () => {
    const worker = setup(async () => page(""));
    worker.cache("cerium-shell-v0");
    worker.cache(SHELL_CACHE);
    worker.cache("someone-else");
    await worker.dispatch("activate", {});
    expect([...worker.caches.keys()].toSorted()).toEqual([SHELL_CACHE, "someone-else"].toSorted());
  });

  it("keeps the newest build's page as it installs", async () => {
    const worker = setup(async (request) => page(`page of ${keyOf(request)}`));
    await worker.dispatch("install", {});
    expect([...worker.cache(SHELL_CACHE).entries.keys()]).toEqual([`${ORIGIN}/app/`]);
  });
});

describe("the service worker's notifications", () => {
  const push = (payload: unknown) => ({ data: { json: () => payload } });

  it("badges the app's icon with the notifications showing", async () => {
    const worker = setup(async () => page(""));
    await worker.dispatch("push", push({ machine: "desk", threadId: "thr_1", title: "Done", body: "" }));
    await worker.dispatch("push", push({ machine: "desk", threadId: "thr_2", title: "Done", body: "" }));
    expect(worker.badges).toEqual([1, 2]);
  });

  it("tells an open app window which machine's thread was tapped", async () => {
    const worker = setup(async () => page(""));
    worker.windows.push({ url: `${ORIGIN}/`, messages: [], focused: 0 });
    worker.windows.push({ url: `${ORIGIN}/v/1.2.3/`, messages: [], focused: 0 });
    await worker.dispatch("notificationclick", {
      notification: { close: () => undefined, data: { machine: "desk", threadId: "thr_1" } },
    });
    // The website on the same origin isn't the app.
    expect(worker.windows[0]!.focused).toBe(0);
    expect(worker.windows[1]!.focused).toBe(1);
    expect(worker.windows[1]!.messages).toEqual([{ type: OPEN_MESSAGE, machine: "desk", threadId: "thr_1" }]);
    expect(worker.opened).toEqual([]);
  });

  it("opens the app on the tapped machine's thread when no window shows it", async () => {
    const worker = setup(async () => page(""));
    worker.windows.push({ url: `${ORIGIN}/`, messages: [], focused: 0 });
    await worker.dispatch("notificationclick", {
      notification: { close: () => undefined, data: { machine: "desk 1", threadId: "thr_1" } },
    });
    expect(worker.opened).toEqual(["/app/?machine=desk%201&thread=thr_1"]);
  });
});
