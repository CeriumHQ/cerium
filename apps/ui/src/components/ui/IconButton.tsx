import { Button } from "@base-ui/react/button";
import type { LucideIcon } from "lucide-react";

import { Tooltip } from "./Tooltip.tsx";

interface IconButtonProps {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly shortcut?: string;
  readonly onClick?: () => void;
  readonly className?: string;
}

/** A quiet square button with a tooltip; the label doubles as its accessible name. */
export function IconButton({ icon: Icon, label, shortcut, onClick, className }: IconButtonProps) {
  return (
    <Tooltip label={label} {...(shortcut ? { shortcut } : {})}>
      <Button
        aria-label={label}
        onClick={onClick}
        className={`grid size-7 place-items-center rounded-md text-fg-tertiary transition-colors duration-150 hover:bg-surface-hover hover:text-fg-secondary active:bg-surface-active ${className ?? ""}`}
      >
        <Icon size={15} strokeWidth={1.75} />
      </Button>
    </Tooltip>
  );
}
