import { readFrameMessage, RENDER_MESSAGE } from "@cerium/artifacts";

// Taking an artifact out of the conversation: a file to keep, or a tab of its own.

/** A file name for an artifact: its title without characters file systems refuse. */
export const artifactFileName = (title: string | undefined, extension: string): string =>
  `${
    (title ?? "")
      .replace(/[<>:"/\\|?*]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "Artifact"
  }.${extension}`;

/** Downloads `blob` as `name`; the desktop shell asks where to save it. */
export const download = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

/**
 * Opens `html`, a standalone artifact document, in a new tab. The page runs as in the conversation,
 * in a frame sandboxed into an opaque origin that loads `host` (the app's `artifact.html`), never in
 * the app's own origin; the tab is driven from here, so it runs no script of the app's.
 */
export const openInTab = (html: string, title: string, host: string): boolean => {
  const view = window.open("", "_blank");
  if (view === null) return false;
  view.document.title = title;
  view.document.body.style.margin = "0";
  const frame = view.document.createElement("iframe");
  frame.title = title;
  frame.setAttribute("sandbox", "allow-scripts allow-forms");
  frame.setAttribute("allow", "clipboard-write");
  frame.referrerPolicy = "no-referrer";
  Object.assign(frame.style, { position: "fixed", inset: "0", width: "100%", height: "100%", border: "0" });
  frame.src = new URL(host, window.location.href).href;
  view.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const message = readFrameMessage(event.data);
    if (message?.kind === "ready") frame.contentWindow?.postMessage({ type: RENDER_MESSAGE, html }, "*");
    else if (message?.kind === "link") view.open(message.url, "_blank", "noopener,noreferrer");
  });
  view.document.body.append(frame);
  return true;
};
