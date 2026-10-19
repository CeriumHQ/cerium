// The web client's service worker: it shows the push notifications the
// relay sends, and opens the thread one is about when it's tapped. It handles no requests, so the app
// always loads from the relay as it is. Built into /sw.js on its own (vite.config.ts): it must not
// import or reference anything outside this file.

/** What the worker posts an open window to show a thread a notification was about. */
export const OPEN_MESSAGE = "cerium:open-thread";

/** Where a window opened for a notification finds its thread: `/?machine=…&thread=…`. */
export const OPEN_PARAMS = { machine: "machine", thread: "thread" } as const;

/** A thread a notification is about. */
interface Opened {
  readonly machine: string;
  readonly threadId: string;
}

interface ExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}

interface WindowClient {
  focus(): Promise<WindowClient>;
  postMessage(message: unknown): void;
}

/** What of a service worker's global scope this one uses. */
export interface ServiceWorkerScope {
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
  };
  readonly clients: {
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<ReadonlyArray<WindowClient>>;
    openWindow(url: string): Promise<WindowClient | null>;
    claim(): Promise<void>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(
    type: "push",
    listener: (event: ExtendableEvent & { readonly data: { json(): unknown } | null }) => void,
  ): void;
  addEventListener(
    type: "notificationclick",
    listener: (event: ExtendableEvent & { readonly notification: Notification }) => void,
  ): void;
}

export function serviceWorker(worker: ServiceWorkerScope) {
  // A new version takes over at once: it only shows notifications.
  worker.addEventListener("install", (event) => event.waitUntil(worker.skipWaiting()));
  worker.addEventListener("activate", (event) => event.waitUntil(worker.clients.claim()));

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
      worker.registration.showNotification(text(payload.title) ?? "Cerium", {
        body: text(payload.body) ?? "",
        // One notification per thread: a newer one replaces it, and still alerts.
        tag: thread ? `${thread.machine}:${thread.threadId}` : "cerium",
        renotify: true,
        icon: "/icon-192.png",
        ...(thread ? { data: thread } : {}),
      }),
    );
  });

  worker.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const data = event.notification.data as Opened | null | undefined;
    event.waitUntil(
      (async () => {
        const [open] = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
        if (open) {
          await open.focus().catch(() => undefined);
          if (data) open.postMessage({ type: OPEN_MESSAGE, machine: data.machine, threadId: data.threadId });
          return;
        }
        const query = data
          ? `?${OPEN_PARAMS.machine}=${encodeURIComponent(data.machine)}&${OPEN_PARAMS.thread}=${encodeURIComponent(data.threadId)}`
          : "";
        await worker.clients.openWindow(`/${query}`);
      })(),
    );
  });
}
