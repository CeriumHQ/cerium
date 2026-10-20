import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CustomRendererProps } from "streamdown";

import { artifactDocument, HEIGHT_MESSAGE, sanitizeArtifact, tokenValues } from "./artifactDocument.ts";

/** Height held while the artifact streams and until its frame reports its own. */
const PLACEHOLDER_HEIGHT = 112;

/** Changes to the mode (`data-theme`) or the palette, which together decide the window's colours. */
const subscribeTheme = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme", "data-palette"] });
  return () => observer.disconnect();
};
const currentTheme = (): "dark" | "light" =>
  document.documentElement.dataset["theme"] === "light" ? "light" : "dark";

/** An agent's HTML visual, rendered in a sandboxed frame once its code fence closes. */
export function Artifact({ code, isIncomplete }: CustomRendererProps) {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme);
  const tokens = useSyncExternalStore(subscribeTheme, tokenValues);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>();
  const [nonce] = useState(() => crypto.randomUUID());

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;
      const { type, height } = data as { type?: unknown; height?: unknown };
      if (type === HEIGHT_MESSAGE && typeof height === "number" && Number.isFinite(height)) {
        setHeight(Math.max(height, 1));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (isIncomplete) {
    return (
      <div
        data-artifact
        style={{ height: PLACEHOLDER_HEIGHT }}
        className="grid place-items-center rounded-[0.625rem] border border-line-subtle bg-surface-hover text-[12.5px]"
      >
        <span className="text-shimmer">Drawing…</span>
      </div>
    );
  }

  return (
    <iframe
      ref={frame}
      data-artifact
      title="Artifact"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={artifactDocument(sanitizeArtifact(code), theme, tokens, nonce)}
      style={{ height: height ?? PLACEHOLDER_HEIGHT }}
      className="block w-full border-0"
    />
  );
}
