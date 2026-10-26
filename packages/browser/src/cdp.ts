// A minimal Chrome DevTools Protocol client over Node's global WebSocket: one connection to one
// page target. Plain promises.

export type Listener = (params: any) => void;

interface Pending {
  readonly resolve: (value: any) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class CdpError extends Error {}

/**
 * What a page is driven through: this module's WebSocket client, or another carrier of the same
 * protocol, such as an Electron web view's own debugger.
 */
export interface CdpSession {
  readonly closed: boolean;
  send<T = any>(method: string, params?: object, timeoutMs?: number): Promise<T>;
  /** Calls `listener` for every `method` event until the returned function is called. */
  on(method: string, listener: Listener): () => void;
  /** The next `method` event, or undefined after `timeoutMs`. */
  once(method: string, timeoutMs: number): Promise<any>;
  close(): void;
}

export class Cdp implements CdpSession {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<Listener>>();
  #closed = false;
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", () => this.fail("The page's debugging connection closed."));
    socket.addEventListener("error", () => this.fail("The page's debugging connection failed."));
  }

  static connect(url: string, timeoutMs = 10_000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new CdpError(`Timed out connecting to ${url}.`));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new Cdp(socket));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new CdpError(`Could not connect to ${url}.`));
      });
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  send<T = any>(method: string, params: object = {}, timeoutMs = 30_000): Promise<T> {
    if (this.#closed) return Promise.reject(new CdpError("The page is closed."));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} took longer than ${timeoutMs / 1000} s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Calls `listener` for every `method` event until the returned function is called. */
  on(method: string, listener: Listener): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
    return () => set.delete(listener);
  }

  /** The next `method` event, or undefined after `timeoutMs`. */
  once(method: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(undefined);
      }, timeoutMs);
      const off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  close(): void {
    this.fail("The page is closed.");
    this.socket.close();
  }

  private receive(data: string) {
    const message = JSON.parse(data) as {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message: string };
    };
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CdpError(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.method !== undefined) {
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    }
  }

  private fail(reason: string) {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CdpError(reason));
    }
    this.pending.clear();
  }
}
