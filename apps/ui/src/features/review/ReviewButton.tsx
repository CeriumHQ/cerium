import { Button } from "@base-ui/react/button";
import type { ThreadId } from "@cerium/protocol";
import type { ReviewTarget } from "@cerium/rpc";
import { useAtomSet } from "@effect/atom-react";
import { ChevronDown, Glasses, LoaderCircle } from "lucide-react";
import { useState } from "react";

import { startReview } from "../../backend/reviews.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/Menu.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { providerName } from "../threads/model.ts";
import { useReviewers, useThreadReviews } from "./hooks.ts";
import { latestReview, reviewerKey, type ReviewerOption } from "./model.ts";

const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "The review couldn't start.";

const half =
  "flex h-7 items-center text-meta text-fg-secondary outline-none transition-colors hover:bg-surface-hover hover:text-fg-primary focus-visible:ring-1 focus-visible:ring-focus-ring data-disabled:cursor-default data-disabled:text-fg-disabled data-disabled:hover:bg-transparent max-md:h-10 max-md:text-[15px]";

/** A pick's row: its harness's logo, its name, and its harness's while that's the lead's own. */
function Option({ option }: { option: ReviewerOption }) {
  return (
    <MenuRadioItem value={reviewerKey(option.reviewer)}>
      <ProviderLogo provider={option.reviewer.provider} size={13} className="shrink-0" />
      <span className="min-w-0 truncate">{option.label}</span>
      <span className="ml-auto pl-3 text-caption text-fg-tertiary">
        {providerName[option.reviewer.provider]}
      </span>
    </MenuRadioItem>
  );
}

/**
 * Asks a model on another harness to review `target` for the thread: a button that starts the review
 * on the chosen model, and beside it the menu that picks another from the roster. Says why when it
 * can't start; the review itself shows where `ReviewCard` is placed.
 */
export function ReviewButton({
  threadId,
  target,
  disabled = false,
  compact = false,
  onError,
}: {
  threadId: ThreadId;
  target: ReviewTarget;
  disabled?: boolean;
  /** Its icon without the word, for a row with little room; the tooltip still says what it does. */
  compact?: boolean;
  /** Why it couldn't start, for the place to show; cleared with `undefined` as another starts. */
  onError: (message: string | undefined) => void;
}) {
  const { options, chosen, pick } = useReviewers(threadId);
  const reviews = useThreadReviews(threadId);
  const start = useAtomSet(startReview, { mode: "promise" });
  const [starting, setStarting] = useState(false);
  const running = latestReview(reviews, target)?.state === "running";
  const busy = starting || running;
  const other = options.filter((option) => option.other);
  const same = options.filter((option) => !option.other);

  const run = async () => {
    if (busy || chosen === undefined) return;
    setStarting(true);
    onError(undefined);
    try {
      await start({ payload: { threadId, target, reviewer: chosen.reviewer } });
    } catch (error) {
      onError(messageOf(error));
    }
    setStarting(false);
  };

  const label =
    chosen === undefined
      ? "Put a model on your roster in Settings → Agents to review with"
      : running
        ? `${chosen.label} is reviewing`
        : `Have ${chosen.label} on ${providerName[chosen.reviewer.provider]} review these changes`;
  const Icon = busy ? LoaderCircle : Glasses;

  return (
    <div className="flex shrink-0 items-center rounded-lg">
      <Tooltip label={label}>
        <Button
          onClick={() => void run()}
          disabled={disabled || chosen === undefined}
          aria-busy={busy}
          focusableWhenDisabled
          {...(compact ? { "aria-label": "Review" } : {})}
          className={`${half} gap-1.5 rounded-l-lg pr-1.5 pl-2 ${options.length > 1 ? "" : "rounded-r-lg pr-2"}`}
        >
          <Icon
            size={14}
            strokeWidth={1.75}
            className={busy ? "animate-spin" : undefined}
            aria-hidden="true"
          />
          {compact ? null : "Review"}
        </Button>
      </Tooltip>
      {options.length > 1 ? (
        <MenuRoot>
          <MenuTrigger>
            <Button
              aria-label="Choose who reviews"
              disabled={disabled}
              className={`${half} rounded-r-lg px-1 data-popup-open:bg-surface-hover`}
            >
              <ChevronDown size={12} strokeWidth={2} />
            </Button>
          </MenuTrigger>
          <MenuPopup>
            <MenuRadioGroup
              value={chosen === undefined ? "" : reviewerKey(chosen.reviewer)}
              onValueChange={(value: string) => {
                const option = options.find((each) => reviewerKey(each.reviewer) === value);
                if (option !== undefined) pick(option);
              }}
            >
              {other.length > 0 ? (
                <MenuGroup>
                  <MenuGroupLabel>Another harness</MenuGroupLabel>
                  {other.map((option) => (
                    <Option key={reviewerKey(option.reviewer)} option={option} />
                  ))}
                </MenuGroup>
              ) : null}
              {other.length > 0 && same.length > 0 ? <MenuSeparator /> : null}
              {same.length > 0 ? (
                <MenuGroup>
                  <MenuGroupLabel>Same harness as the change</MenuGroupLabel>
                  {same.map((option) => (
                    <Option key={reviewerKey(option.reviewer)} option={option} />
                  ))}
                </MenuGroup>
              ) : null}
            </MenuRadioGroup>
          </MenuPopup>
        </MenuRoot>
      ) : null}
    </div>
  );
}
