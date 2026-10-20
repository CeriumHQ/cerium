// What runs inside an artifact's frame ahead of the page's own scripts, and the messages it trades with
// the window. `artifactRuntime` is serialized with `Function.prototype.toString` into the document, so
// it must not reference anything outside its own body: everything it needs arrives as `options`.

/** Every message between a frame and the window starts with this. */
export const MESSAGE_PREFIX = "cerium-artifact:";

/** The window → frame messages: the document to render (to the host page) and a new theme. */
export const RENDER_MESSAGE = `${MESSAGE_PREFIX}render`;
export const THEME_MESSAGE = `${MESSAGE_PREFIX}theme`;

export interface RuntimeOptions {
  readonly prefix: string;
  readonly mode: "dark" | "light";
  readonly variables: Readonly<Record<string, string>>;
  /** Whether the page uses the frozen building blocks, whose tabs the runtime builds. */
  readonly legacy: boolean;
}

/** A theme as the window sends it: the stylesheet to swap in, and the values for scripts. */
export interface ThemeUpdate {
  readonly mode: "dark" | "light";
  readonly css: string;
  readonly variables: Readonly<Record<string, string>>;
}

/**
 * Runs in the frame's `<head>`, before the page: keeps the theme `<style>` current, offers scripts
 * `window.cerium`, reports the page's height, hands links, app shortcuts, errors and replies to the
 * window, and builds legacy tabs.
 */
export function artifactRuntime(options: RuntimeOptions) {
  const framed = window.parent !== window;
  const post = (kind: string, data: Record<string, unknown>) => {
    if (framed) window.parent.postMessage({ ...data, type: options.prefix + kind }, "*");
  };
  const root = document.documentElement;
  const themeStyle = document.getElementById("cerium-theme");
  const listeners: Array<(theme: unknown) => void> = [];
  const api = {
    mode: options.mode,
    theme: { ...options.variables },
    /** A theme variable's colour, resolved, for canvas and chart libraries that can't read CSS variables. */
    color(name: string): string {
      const probe = document.createElement("i");
      probe.style.color = name.startsWith("--") ? `var(${name})` : name;
      probe.style.display = "none";
      (document.body ?? root).append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    },
    /** Calls `listener` each time the user changes theme or mode, after the variables have changed. */
    onThemeChange(listener: (theme: unknown) => void) {
      listeners.push(listener);
    },
    /**
     * Puts `text` in the user's message box, replacing what this page put there last if it's still
     * there; the user sends it. Only in answer to a click or a key, never on its own.
     */
    reply(text: string): boolean {
      const activation = (navigator as { userActivation?: { isActive: boolean } }).userActivation;
      if (!framed || typeof text !== "string" || text.trim() === "" || activation?.isActive !== true) {
        return false;
      }
      post("reply", { text: text.trim().slice(0, 4000) });
      return true;
    },
  };
  root.dataset["theme"] = options.mode;
  Object.defineProperty(window, "cerium", { value: api });

  window.addEventListener("message", (event) => {
    const data: unknown = event.data;
    if (event.source !== window.parent || typeof data !== "object" || data === null) return;
    const { type, theme } = data as { type?: unknown; theme?: unknown };
    if (type !== `${options.prefix}theme` || typeof theme !== "object" || theme === null) return;
    const { mode, css, variables } = theme as Partial<ThemeUpdate>;
    if ((mode !== "dark" && mode !== "light") || typeof css !== "string" || typeof variables !== "object")
      return;
    if (themeStyle) themeStyle.textContent = css;
    root.dataset["theme"] = mode;
    api.mode = mode;
    api.theme = { ...variables };
    window.dispatchEvent(new CustomEvent("cerium:themechange", { detail: api }));
    for (const listener of listeners) {
      try {
        listener(api);
      } catch (error) {
        fail(error);
      }
    }
  });

  // Links open in the user's browser, never inside the frame. A page saved or opened on its own is
  // already in a browser, and its links work as they are.
  const openLink = (href: string) => {
    let url: URL;
    try {
      url = new URL(href, document.baseURI);
    } catch {
      return false;
    }
    if (!/^(https?|mailto):$/.test(url.protocol)) return false;
    post("link", { url: url.href });
    return true;
  };
  document.addEventListener(
    "click",
    (event) => {
      const link = event.composedPath().find((target): target is HTMLAnchorElement => {
        return target instanceof Element && target.matches("a[href]");
      });
      const href = link?.getAttribute("href");
      if (!framed || href === undefined || href === null || href.startsWith("#")) return;
      event.preventDefault();
      openLink(href);
    },
    true,
  );
  if (framed) {
    window.open = (href?: string | URL) => {
      if (href !== undefined) openLink(String(href));
      return null;
    };
  }

  // An element with `data-cerium-reply` answers with its text when clicked, and is marked
  // `data-chosen` (the others lose it) so the page can show the choice.
  document.addEventListener("click", (event) => {
    if (!event.isTrusted || event.defaultPrevented) return;
    const choice = event.composedPath().find((target): target is HTMLElement => {
      return target instanceof HTMLElement && target.hasAttribute("data-cerium-reply");
    });
    const text = choice?.getAttribute("data-cerium-reply");
    if (!choice || !text || !api.reply(text)) return;
    for (const other of document.querySelectorAll("[data-chosen]")) other.removeAttribute("data-chosen");
    choice.setAttribute("data-chosen", "");
  });

  // A focused frame keeps keys from the window, so app shortcuts the page leaves alone are handed on.
  window.addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.isComposing) return;
    const chord = event.ctrlKey || event.metaKey;
    if (!chord && event.key !== "Escape") return;
    const target = event.composedPath()[0];
    const typing =
      target instanceof HTMLElement &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (typing && event.key !== "Escape") return;
    setTimeout(() => {
      if (event.defaultPrevented) return;
      post("key", {
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
      });
    });
  });

  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    post("error", { message: message.slice(0, 500) });
  };
  window.addEventListener(
    "error",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target !== (root as HTMLElement)) {
        const source = target.getAttribute("src") ?? target.getAttribute("href");
        if (source !== null) fail(`Couldn't load ${source}`);
        return;
      }
      fail((event as ErrorEvent).error ?? (event as ErrorEvent).message);
    },
    true,
  );
  window.addEventListener("unhandledrejection", (event) => fail(event.reason));

  // The frame is as tall as the page, so the transcript scrolls and the page never does.
  let reported = -1;
  const report = () => {
    const height = Math.ceil(
      root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height,
    );
    if (height === reported) return;
    reported = height;
    post("height", { height });
  };
  const observer = new ResizeObserver(report);
  observer.observe(root);
  document.addEventListener("DOMContentLoaded", () => {
    if (document.body) observer.observe(document.body);
    if (options.legacy) buildTabs();
    report();
  });
  window.addEventListener("load", report);
  void document.fonts?.ready.then(report);

  // The window can't see the pointer over the frame, and shows the artifact's tools while it is.
  root.addEventListener("pointerenter", () => post("pointer", { inside: true }));
  root.addEventListener("pointerleave", () => post("pointer", { inside: false }));

  /** Legacy `.tabs`: each `section` becomes a tab named by its `data-tab`. */
  function buildTabs() {
    let group = 0;
    for (const tabs of document.querySelectorAll<HTMLElement>(".tabs")) {
      const sections = [...tabs.children].filter(
        (child): child is HTMLElement => child instanceof HTMLElement && child.tagName === "SECTION",
      );
      if (sections.length === 0) continue;
      group++;
      const list = document.createElement("div");
      list.className = "tablist";
      list.setAttribute("role", "tablist");
      const buttons = sections.map((section, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.id = `tab-${group}-${index}`;
        button.setAttribute("role", "tab");
        button.setAttribute("aria-controls", `panel-${group}-${index}`);
        button.append(section.dataset["tab"] ?? `Tab ${index + 1}`);
        section.id = `panel-${group}-${index}`;
        section.setAttribute("role", "tabpanel");
        section.setAttribute("aria-labelledby", button.id);
        return button;
      });
      const select = (selected: number) => {
        buttons.forEach((button, index) => {
          button.setAttribute("aria-selected", String(index === selected));
          button.tabIndex = index === selected ? 0 : -1;
          sections[index]!.hidden = index !== selected;
        });
      };
      buttons.forEach((button, index) => button.addEventListener("click", () => select(index)));
      list.addEventListener("keydown", (event) => {
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const step = ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[event.key];
        if (current < 0 || step === undefined) return;
        const next = (current + step + buttons.length) % buttons.length;
        select(next);
        buttons[next]!.focus();
        event.preventDefault();
      });
      list.append(...buttons);
      tabs.prepend(list);
      select(0);
    }
  }
}

/** A message a frame sent the window, read defensively: the page inside can send anything. */
export type FrameMessage =
  | { readonly kind: "ready" }
  | { readonly kind: "height"; readonly height: number }
  | { readonly kind: "link"; readonly url: string }
  | {
      readonly kind: "key";
      readonly key: string;
      readonly code: string;
      readonly ctrlKey: boolean;
      readonly metaKey: boolean;
      readonly shiftKey: boolean;
      readonly altKey: boolean;
    }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "pointer"; readonly inside: boolean }
  | { readonly kind: "reply"; readonly text: string };

export const readFrameMessage = (data: unknown): FrameMessage | undefined => {
  if (typeof data !== "object" || data === null) return undefined;
  const message = data as Record<string, unknown>;
  const type = message["type"];
  if (typeof type !== "string" || !type.startsWith(MESSAGE_PREFIX)) return undefined;
  switch (type.slice(MESSAGE_PREFIX.length)) {
    case "ready":
      return { kind: "ready" };
    case "height": {
      const height = message["height"];
      return typeof height === "number" && Number.isFinite(height) && height >= 0
        ? { kind: "height", height }
        : undefined;
    }
    case "link": {
      const url = message["url"];
      return typeof url === "string" && /^(https?|mailto):/i.test(url) ? { kind: "link", url } : undefined;
    }
    case "key": {
      const { key, code } = message;
      if (typeof key !== "string" || typeof code !== "string") return undefined;
      return {
        kind: "key",
        key,
        code,
        ctrlKey: message["ctrlKey"] === true,
        metaKey: message["metaKey"] === true,
        shiftKey: message["shiftKey"] === true,
        altKey: message["altKey"] === true,
      };
    }
    case "error": {
      const text = message["message"];
      return typeof text === "string" ? { kind: "error", message: text.slice(0, 500) } : undefined;
    }
    case "pointer":
      return { kind: "pointer", inside: message["inside"] === true };
    case "reply": {
      const text = message["text"];
      return typeof text === "string" && text.trim() !== ""
        ? { kind: "reply", text: text.trim().slice(0, 4000) }
        : undefined;
    }
    default:
      return undefined;
  }
};
