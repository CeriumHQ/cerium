import { Button } from "@base-ui/react/button";
import { Check, Copy, FolderOpen, RotateCcw } from "lucide-react";
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";

import { shellBridge } from "../../backend/shell.ts";
import { CeriumMark } from "../../components/CeriumMark.tsx";
import type { CrashFallback } from "./CrashGuard.tsx";
import { renderErrorDetails, renderErrorMessage } from "./model.ts";

const buttonClass =
  "inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-body font-medium text-fg-primary transition-colors hover:bg-surface-hover max-md:h-10 max-md:px-4 max-md:text-[15px]";

/** Copies `text`, and says so for a moment; `link` draws it as a link in a line of text. */
export function CopyDetailsButton({ text, link }: { text: string; link?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      className={link ?? buttonClass}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => undefined,
        )
      }
    >
      {link !== undefined ? null : copied ? (
        <Check size={14} strokeWidth={2} />
      ) : (
        <Copy size={14} strokeWidth={1.75} />
      )}
      {copied ? "Copied" : "Copy details"}
    </Button>
  );
}

/** Opens the folder of Cerium's logs; absent outside the desktop app. */
function LogsButton() {
  const openLogs = shellBridge()?.openLogs;
  if (openLogs === undefined) return null;
  return (
    <Button className={buttonClass} onClick={() => void openLogs()}>
      <FolderOpen size={14} strokeWidth={1.75} />
      Logs
    </Button>
  );
}

function CrashActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap justify-center gap-2">{children}</div>;
}

/**
 * The whole window, when what threw was the app around every pane: the window shows (the launch
 * screen may never have said it could), and Reload starts the page over.
 */
export function AppCrash({ error, componentStack }: ComponentProps<CrashFallback>) {
  useEffect(() => shellBridge()?.windowReady?.(), []);
  return (
    <div
      role="alert"
      className="fixed inset-0 flex flex-col items-center justify-center gap-5 bg-surface-window px-6"
    >
      <div className="absolute inset-x-0 top-0 h-10 [app-region:drag]" />
      <CeriumMark className="size-10 text-fg-tertiary" />
      <div className="flex max-w-md flex-col items-center gap-1.5 text-center">
        <h1 className="text-reading font-semibold tracking-tight text-fg-primary">Cerium hit a problem</h1>
        <p className="text-body text-fg-secondary">{renderErrorMessage(error)}</p>
      </div>
      <CrashActions>
        <Button className={buttonClass} onClick={() => location.reload()}>
          <RotateCcw size={14} strokeWidth={1.75} />
          Reload
        </Button>
        <CopyDetailsButton text={renderErrorDetails(error, componentStack, shellBridge()?.platform)} />
        <LogsButton />
      </CrashActions>
    </div>
  );
}

/** One pane, when what threw was drawn inside it: the rest of the window carries on. */
export function PaneCrash({ error, componentStack, retry }: ComponentProps<CrashFallback>) {
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-4 px-6">
      <div className="flex max-w-sm flex-col items-center gap-1 text-center">
        <p className="text-body font-medium text-fg-primary">This view couldn't be drawn</p>
        <p className="text-meta text-fg-secondary">{renderErrorMessage(error)}</p>
      </div>
      <CrashActions>
        <Button className={buttonClass} onClick={retry}>
          <RotateCcw size={14} strokeWidth={1.75} />
          Try again
        </Button>
        <CopyDetailsButton text={renderErrorDetails(error, componentStack, shellBridge()?.platform)} />
      </CrashActions>
    </div>
  );
}
