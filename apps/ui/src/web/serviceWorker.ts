// The web client's service worker: it shows the push notifications the relay sends, keeps the Home
// Screen badge, opens the thread a notification is about when it's tapped, and keeps the app's page
// and its files so the app starts at once, and offline. Each version's files live under
// `/v/<version>/assets/` and never change, so they come from the cache first; the app's page comes
// from the relay when it answers quickly, and from the cache when it doesn't. Nothing under `/api/`
// is ever kept. Built into /sw.js on its own (vite.config.ts): it must not import or reference
// anything outside this file.

/** What the worker posts an open window to show a thread a notification was about. */
export const OPEN_MESSAGE = "cerium:open-thread";

/** Where a window opened for a notification finds its thread: `/?machine=…&thread=…`. */
export const OPEN_PARAMS = { machine: "machine", thread: "thread" } as const;

/** The app's pages, each version's and the newest's, as they were last loaded. */
export const SHELL_CACHE = "cerium-shell-v1";
/** Every version's files, which never change once built. */
export const ASSET_CACHE = "cerium-assets-v1";
/** The caches this worker keeps; any other of Cerium's is an earlier worker's, and goes. */
const OWN_CACHES: ReadonlySet<string> = new Set([SHELL_CACHE, ASSET_CACHE]);
/** How many files the asset cache keeps before the oldest go: a few versions' worth. */
export const ASSETS_KEPT = 400;
/** How long the app's page waits for the relay before the kept copy shows instead. */
export const SHELL_WAIT_MS = 2_500;
/** The newest build's page, kept when the worker installs so the first launch offline opens. */
const APP_PAGE = "/app/";

/** A thread a notification is about. */
interface Opened {
  readonly machine: string;
  readonly threadId: string;
}

interface ExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}

interface WindowClient {
  readonly url: string;
  focus(): Promise<WindowClient>;
  postMessage(message: unknown): void;
}

/** What of the Cache API the worker uses. */
export interface WorkerCache {
  match(request: Request | string): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
  keys(): Promise<ReadonlyArray<Request>>;
  delete(request: Request | string): Promise<boolean>;
}

/** What of a service worker's global scope this one uses. */
export interface ServiceWorkerScope {
  readonly location: { readonly origin: string };
  readonly registration: {
    showNotification(
      title: string,
      options: {
        readonly body: string;
        readonly tag: string;
        readonly renotify: boolean;
        readonly icon: string;
        readonly data?: Opened;
      },
    ): Promise<void>;
    getNotifications?(): Promise<ReadonlyArray<unknown>>;
  };
  readonly clients: {
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<ReadonlyArray<WindowClient>>;
    openWindow(url: string): Promise<WindowClient | null>;
    claim(): Promise<void>;
  };
  readonly caches: {
    open(name: string): Promise<WorkerCache>;
    keys(): Promise<ReadonlyArray<string>>;
    delete(name: string): Promise<boolean>;
  };
  readonly navigator: {
    setAppBadge?(count?: number): Promise<void>;
    clearAppBadge?(): Promise<void>;
  };
  fetch(request: Request | string): Promise<Response>;
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
  addEventListener(
    type: "push",
    listener: (event: ExtendableEvent & { readonly data: { json(): unknown } | null }) => void,
  ): void;
  addEventListener(
    type: "notificationclick",
    listener: (event: ExtendableEvent & { readonly notification: Notification }) => void,
  ): void;
}

/**
 * What the worker does with a request: `asset` for a version's file, `shell` for the app's page, and
 * nothing for anything else, the relay's API among it, which always goes to the relay as it is.
 */
export const requestKind = (url: URL, origin: string): "asset" | "shell" | undefined => {
  if (url.origin !== origin || url.pathname.startsWith("/api/")) return undefined;
  if (/^\/v\/[^/]+\/assets\//.test(url.pathname)) return "asset";
  if (/^\/(?:app|v\/[^/]+)\/(?:index\.html)?$/.test(url.pathname)) return "shell";
  return undefined;
};

/** Where the app's page is kept: its folder, whatever the address carried, such as a tapped thread. */
export const shellKey = (url: URL) => `${url.origin}${url.pathname.replace(/index\.html$/, "")}`;

/** A response worth keeping: the relay's own, whole and not a redirect, which a page can't be served as. */
const keepable = (response: Response) =>
  response.ok && !response.redirected && (response.type === "basic" || response.type === "default");

/** A window showing the app, rather than the website on the same origin. */
const isAppWindow = (client: WindowClient) => {
  try {
    return /^\/(?:app|v\/[^/]+)\//.test(new URL(client.url).pathname);
  } catch {
    return false;
  }
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function serviceWorker(worker: ServiceWorkerScope) {
  /** Badges the app's icon with how many notifications are showing; best effort, where supported. */
  const syncBadge = async () => {
    try {
      const shown = (await worker.registration.getNotifications?.())?.length;
      if (shown === undefined) return;
      if (shown > 0) await worker.navigator.setAppBadge?.(shown);
      else await worker.navigator.clearAppBadge?.();
    } catch {
      // The badge is a hint; a browser that can't show one still shows the notification.
    }
  };

  /** Keeps the app's page, when the relay serves it as a page can be served. */
  const keepShell = async (key: string, response: Response) => {
    if (!keepable(response)) return;
    await (await worker.caches.open(SHELL_CACHE)).put(key, response);
  };

  /** Drops the oldest files once there are more than a few versions' worth. */
  const trimAssets = async (cache: WorkerCache) => {
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - ASSETS_KEPT)).map((key) => cache.delete(key)));
  };

  /** The app's page from the relay, unless it's slow or unreachable and a kept copy can show instead. */
  const shell = async (event: FetchEvent, url: URL): Promise<Response> => {
    const key = shellKey(url);
    const network = worker.fetch(event.request);
    // Whatever shows, the page fetched keeps loading so the next launch has it. Kept from a copy
    // taken before anything reads the response.
    event.waitUntil(network.then((response) => keepShell(key, response.clone())).catch(() => undefined));
    const kept = await (await worker.caches.open(SHELL_CACHE)).match(key).catch(() => undefined);
    if (kept === undefined) return network;
    return Promise.race([
      network.then((response) => (response.status >= 500 ? kept : response)).catch(() => kept),
      delay(SHELL_WAIT_MS).then(() => kept),
    ]);
  };

  /** A version's file from the cache, else from the relay, kept for next time. */
  const asset = async (event: FetchEvent): Promise<Response> => {
    const cache = await worker.caches.open(ASSET_CACHE);
    const kept = await cache.match(event.request).catch(() => undefined);
    if (kept !== undefined) return kept;
    const response = await worker.fetch(event.request);
    if (keepable(response)) {
      event.waitUntil(
        cache
          .put(event.request, response.clone())
          .then(() => trimAssets(cache))
          .catch(() => undefined),
      );
    }
    return response;
  };

  // A new version takes over at once: what it keeps is named by version, so the old pages still load.
  worker.addEventListener("install", (event) =>
    event.waitUntil(
      Promise.all([
        worker.skipWaiting(),
        worker
          .fetch(APP_PAGE)
          .then((response) => keepShell(shellKey(new URL(APP_PAGE, worker.location.origin)), response))
          .catch(() => undefined),
      ]),
    ),
  );
  worker.addEventListener("activate", (event) =>
    event.waitUntil(
      (async () => {
        const names = await worker.caches.keys().catch(() => []);
        await Promise.all(
          names
            .filter((name) => name.startsWith("cerium-") && !OWN_CACHES.has(name))
            .map((name) => worker.caches.delete(name)),
        );
        await worker.clients.claim();
      })(),
    ),
  );

  worker.addEventListener("fetch", (event) => {
    const { request } = event;
    if (request.method !== "GET" || request.headers.has("range")) return;
    const url = new URL(request.url);
    const kind = requestKind(url, worker.location.origin);
    if (kind === "asset") event.respondWith(asset(event));
    else if (kind === "shell") event.respondWith(shell(event, url));
  });

  worker.addEventListener("push", (event) => {
    let payload: Partial<Record<"machine" | "threadId" | "title" | "body", unknown>> = {};
    try {
      const data: unknown = event.data?.json();
      if (typeof data === "object" && data !== null) payload = data;
    } catch {
      // Shown as Cerium's, without a thread: every push must show something.
    }
    const text = (value: unknown) => (typeof value === "string" ? value : undefined);
    const machine = text(payload.machine);
    const threadId = text(payload.threadId);
    const thread = machine && threadId ? { machine, threadId } : undefined;
    event.waitUntil(
      worker.registration
        .showNotification(text(payload.title) ?? "Cerium", {
          body: text(payload.body) ?? "",
          // One notification per thread: a newer one replaces it, and still alerts.
          tag: thread ? `${thread.machine}:${thread.threadId}` : "cerium",
          renotify: true,
          icon: "/icon-192.png",
          ...(thread ? { data: thread } : {}),
        })
        .then(syncBadge),
    );
  });

  worker.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const data = event.notification.data as Opened | null | undefined;
    event.waitUntil(
      (async () => {
        await syncBadge();
        const windows = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
        // The website shares the origin, and would only be focused to ignore the message.
        const open = windows.find(isAppWindow);
        if (open) {
          await open.focus().catch(() => undefined);
          if (data) open.postMessage({ type: OPEN_MESSAGE, machine: data.machine, threadId: data.threadId });
          return;
        }
        const query = data
          ? `?${OPEN_PARAMS.machine}=${encodeURIComponent(data.machine)}&${OPEN_PARAMS.thread}=${encodeURIComponent(data.threadId)}`
          : "";
        await worker.clients.openWindow(`${APP_PAGE}${query}`);
      })(),
    );
  });
}
