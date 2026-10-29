import { Button } from "@base-ui/react/button";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Swap } from "../../components/Swap.tsx";
import { copyText } from "./menus.ts";

/** A small button that copies `text` and says so for a moment. The caller decides when it shows. */
export function CopyButton({
  text,
  label = "Copy",
  className = "",
}: {
  text: string | (() => string);
  /** What it copies, for its accessible name: "Copy command". */
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() => {
        copyText(typeof text === "function" ? text() : text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={`grid size-6 shrink-0 place-items-center rounded-md text-fg-tertiary transition-[color,background-color,opacity] hover:bg-surface-hover hover:text-fg-primary pointer-coarse:size-8 ${className}`}
    >
      <Swap which={copied ? "copied" : "copy"}>
        {copied ? <Check size={13} strokeWidth={2.25} /> : <Copy size={13} strokeWidth={1.75} />}
      </Swap>
    </Button>
  );
}
