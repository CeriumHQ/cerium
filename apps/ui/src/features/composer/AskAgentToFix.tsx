import { Button } from "@base-ui/react/button";
import { Check, CircleAlert, LoaderCircle, TextCursorInput, Wrench } from "lucide-react";
import { useRef, useState } from "react";

import { buttonClass } from "../../components/ui/Button.tsx";
import { agentFixPrompt, type AgentFixFailure, type AskAgentFix } from "./agentFix.ts";

type Status = "ready" | "sending" | "sent" | "draft";

const words: Record<Status, string> = {
  ready: "Ask agent to fix",
  sending: "Sending…",
  sent: "Sent to agent",
  draft: "Added to message box",
};

/**
 * Where it sits: `inline` beside a status line's quiet actions (a terminal's Restart), `button` as a
 * bordered button of its own under a failure (a commit's).
 */
const look = {
  inline:
    "flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 whitespace-nowrap text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary disabled:pointer-events-none",
  button: `${buttonClass({ tone: "neutral", size: "sm" })} mt-1 self-start`,
} as const;

function StatusIcon({ status }: { status: Status }) {
  const props = { size: 12, strokeWidth: 1.75, "aria-hidden": true, className: "shrink-0" } as const;
  switch (status) {
    case "sending":
      return <LoaderCircle {...props} className="shrink-0 animate-spin text-fg-tertiary" />;
    case "sent":
      return <Check {...props} strokeWidth={2} className="shrink-0 text-success-text" />;
    case "draft":
      return <TextCursorInput {...props} className="shrink-0 text-fg-tertiary" />;
    default:
      return <Wrench {...props} />;
  }
}

/**
 * Hands a failure to the thread's agent: sent as a message while it's free, otherwise left in the
 * message box. It says where the request went, once, and offers itself again only if it didn't get there.
 */
export function AskAgentToFix({
  failure,
  onAskFix,
  disabled,
  variant = "inline",
}: {
  failure: () => AgentFixFailure;
  onAskFix: AskAgentFix;
  disabled?: boolean;
  variant?: keyof typeof look;
}) {
  const pending = useRef(false);
  const [status, setStatus] = useState<Status>("ready");
  const [error, setError] = useState<string>();

  const ask = async () => {
    if (disabled || pending.current || status !== "ready") return;
    pending.current = true;
    setStatus("sending");
    setError(undefined);
    try {
      const delivered = await onAskFix(agentFixPrompt(failure()));
      setStatus(delivered);
    } catch (failure) {
      pending.current = false;
      setStatus("ready");
      setError(
        typeof failure === "object" &&
          failure !== null &&
          "message" in failure &&
          typeof failure.message === "string"
          ? failure.message
          : "Couldn't ask the agent to fix this. Try again.",
      );
    }
  };

  const done = status === "sent" || status === "draft";
  return (
    <>
      <Button
        disabled={disabled || status !== "ready"}
        onClick={() => void ask()}
        aria-live="polite"
        className={`${look[variant]} ${
          done
            ? "disabled:opacity-100! data-disabled:opacity-100!"
            : "disabled:opacity-40 data-disabled:opacity-40"
        }`}
      >
        <StatusIcon status={status} />
        {words[status]}
      </Button>
      {error === undefined ? null : (
        <span
          role="alert"
          className="flex min-w-0 items-center gap-1 text-meta text-error-text max-md:text-[14px]"
        >
          <CircleAlert size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
          <span className={variant === "inline" ? "truncate" : ""}>{error}</span>
        </span>
      )}
    </>
  );
}
