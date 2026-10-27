import { Button } from "@base-ui/react/button";
import { Copy, FolderOpen, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";

import { shellBridge } from "../../backend/shell.ts";
import { MenuItem, MenuPopup, MenuRoot, MenuSeparator, MenuTrigger } from "../../components/ui/Menu.tsx";

// One program Settings lists, a harness or `gh`: its mark, its name, the account it runs on or what it
// needs, and the one thing to do about it. A dot on the mark says a newer release is out. The version
// and where it's installed wait in the row's menu.

export function ToolRow({
  mark,
  name,
  detail,
  tone = "quiet",
  dim = false,
  newer,
  action,
  menu,
}: {
  readonly mark: ReactNode;
  readonly name: string;
  /** The account, or the state: "Claude Max", "Not signed in". */
  readonly detail: ReactNode;
  /** `attention` while the program can't be used as it is. */
  readonly tone?: "quiet" | "attention";
  /** The mark fades while the program can't be used. */
  readonly dim?: boolean;
  /** Its newest release, when that's newer than the installed one. */
  readonly newer?: string | undefined;
  readonly action?: ReactNode;
  /** The row's menu, behind ⋯. */
  readonly menu?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="relative grid size-8 shrink-0 place-items-center rounded-lg border border-line-subtle bg-surface-raised text-fg-primary">
        <span className={dim ? "opacity-35 grayscale" : undefined}>{mark}</span>
        {newer === undefined ? null : (
          <span
            title={`${newer} is out`}
            aria-label={`Update available: ${newer}`}
            className="absolute -top-1 -right-1 size-2.5 rounded-full bg-running shadow-[0_0_0_2px_var(--window)]"
          />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-reading font-medium text-fg-primary">{name}</span>
        <span
          className={`truncate text-meta ${tone === "attention" ? "text-attention-text" : "text-fg-tertiary"}`}
        >
          {detail}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {action}
        {menu === undefined ? null : (
          <MenuRoot>
            <MenuTrigger>
              <Button
                aria-label={`More for ${name}`}
                className="grid size-7 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary data-popup-open:bg-surface-hover data-popup-open:text-fg-primary"
              >
                <MoreHorizontal size={15} strokeWidth={1.75} />
              </Button>
            </MenuTrigger>
            <MenuPopup>{menu}</MenuPopup>
          </MenuRoot>
        )}
      </div>
    </div>
  );
}

/** A row's action: `primary` for what the program needs before it can be used. */
export function RowButton({
  tone = "neutral",
  onClick,
  children,
}: {
  readonly tone?: "primary" | "neutral";
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Button
      onClick={onClick}
      className={`flex h-7 items-center rounded-md px-3 text-meta font-medium transition-colors ${
        tone === "primary"
          ? "bg-accent text-accent-fg hover:bg-accent-strong"
          : "border border-line-subtle text-fg-secondary hover:bg-surface-hover hover:text-fg-primary"
      }`}
    >
      {children}
    </Button>
  );
}

/** A row's action that opens a page in the browser, such as the download. */
export function RowLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex h-7 items-center rounded-md border border-line-subtle px-3 text-meta font-medium text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
    >
      {children}
    </a>
  );
}

/**
 * The menu of an installed program: its version, and its install path to copy or show. Showing it
 * needs the desktop app, on this computer.
 */
export function InstalledMenu({
  version,
  newer,
  path,
  local,
  children,
}: {
  readonly version: string;
  readonly newer: string | undefined;
  readonly path: string;
  /** The program is on this computer, not one the window drives. */
  readonly local: boolean;
  /** Items of the program's own, after these. */
  readonly children?: ReactNode;
}) {
  const reveal = local ? shellBridge()?.revealPath : undefined;
  return (
    <>
      <div className="flex flex-col px-2 pt-1.5 pb-1 text-meta text-fg-tertiary select-none">
        <span>
          Version <span className="font-mono text-fg-secondary tabular-nums">{version}</span>
        </span>
        {newer === undefined ? null : (
          <span>
            <span className="font-mono text-fg-secondary tabular-nums">{newer}</span> is out
          </span>
        )}
      </div>
      <MenuSeparator />
      <MenuItem icon={Copy} onClick={() => void navigator.clipboard.writeText(path).catch(() => undefined)}>
        Copy install path
      </MenuItem>
      {reveal === undefined ? null : (
        <MenuItem icon={FolderOpen} onClick={() => void reveal(path).catch(() => undefined)}>
          Show in folder
        </MenuItem>
      )}
      {children}
    </>
  );
}
