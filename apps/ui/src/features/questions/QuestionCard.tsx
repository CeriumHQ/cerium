import { Button } from "@base-ui/react/button";
import { Checkbox } from "@base-ui/react/checkbox";
import { Input } from "@base-ui/react/input";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Tabs } from "@base-ui/react/tabs";
import type { Question, QuestionResponse } from "@cerium/protocol";
import { Ban, Check, MessageCircleQuestionMark, X } from "lucide-react";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";

import { InfoTip } from "../../components/ui/InfoTip.tsx";
import { approvalShell, primary, quiet } from "../agents/ApprovalParts.tsx";
import type { QuestionResolution } from "../transcript/model.ts";
import {
  answerLine,
  coldFor,
  emptyDrafts,
  isAnswered,
  optionName,
  pick,
  toResponse,
  write,
  type Draft,
} from "./model.ts";

// Questions agents put to the user with `ask_user`: a card to answer them while they are open, and
// what was answered once they close.

/** Sends the user's response; resolves to false when it didn't reach the agent, so the card stays. */
export type AnswerQuestions = (response: QuestionResponse) => Promise<boolean> | void;

const row =
  "group flex w-full cursor-default items-start gap-2.5 px-3 py-2 text-left outline-none transition-colors select-none hover:bg-surface-hover focus-visible:bg-surface-hover data-checked:bg-surface-selected max-md:py-2.5";

/** The ring or box before an option, filled once the option is picked. */
const mark =
  "mt-[3px] grid size-3.5 shrink-0 place-items-center border border-line-strong transition-colors group-data-checked:border-accent group-data-checked:bg-accent group-focus-visible:border-fg-secondary";

function OptionText({ label, description }: { label: string; description: string | undefined }) {
  const { name, recommended } = optionName(label);
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] leading-[1.35] text-fg-primary max-md:text-[14px]">
        {name}
        {recommended ? (
          <span className="rounded-sm bg-accent-soft px-1.5 text-2xs font-medium text-fg-secondary">
            Recommended
          </span>
        ) : null}
      </span>
      {description ? (
        <span className="text-xs leading-[1.45] text-fg-tertiary max-md:text-[13px]">{description}</span>
      ) : null}
    </span>
  );
}

/** The user's own words, as the last row of the options, or the whole answer where there are none. */
function OwnWords({
  question,
  draft,
  onChange,
  onEnter,
}: {
  question: Question;
  draft: Draft;
  onChange: (text: string) => void;
  onEnter: () => void;
}) {
  const alone = question.options.length === 0;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onEnter();
  };
  if (alone) {
    return (
      <textarea
        value={draft.text}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        aria-label="Your answer"
        placeholder="Your answer"
        className="field-sizing-content max-h-40 min-h-16 w-full resize-none rounded-md border border-line-subtle bg-surface-window px-3 py-2 text-[13px] leading-[1.5] text-fg-primary outline-none placeholder:text-fg-tertiary focus:border-line-strong max-md:text-[14px]"
      />
    );
  }
  const used = draft.text.trim() !== "";
  return (
    // The label holds Base UI's input, which the rule can't see is a control.
    // oxlint-disable-next-line jsx-a11y/label-has-associated-control
    <label
      className={`flex items-center gap-2.5 px-3 py-1.5 transition-colors ${used ? "bg-surface-selected" : ""}`}
    >
      <span
        aria-hidden
        className={`size-3.5 shrink-0 border border-dashed ${question.multiSelect ? "rounded-[4px]" : "rounded-full"} ${used ? "border-fg-secondary" : "border-line-strong"}`}
      />
      <Input
        value={draft.text}
        onValueChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={question.multiSelect ? "Add your own…" : "Something else…"}
        className="h-6 min-w-0 flex-1 bg-transparent text-[13px] text-fg-primary outline-none placeholder:text-fg-tertiary max-md:h-8 max-md:text-[14px]"
      />
    </label>
  );
}

/** One question with its options: pick one, pick several, or write. */
function QuestionBody({
  question,
  draft,
  onChange,
  onPicked,
  onEnter,
}: {
  question: Question;
  draft: Draft;
  onChange: (draft: Draft) => void;
  /** A question of one choice was answered by picking it. */
  onPicked: () => void;
  onEnter: () => void;
}) {
  const list =
    "flex flex-col divide-y divide-line-subtle overflow-hidden rounded-md border border-line-subtle bg-surface-window";
  const words = question.allowOther ? (
    <OwnWords
      question={question}
      draft={draft}
      onChange={(text) => onChange(write(question, draft, text))}
      onEnter={onEnter}
    />
  ) : null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[14px] leading-[1.4] font-semibold break-words whitespace-pre-wrap text-fg-primary select-text max-md:text-[15px]">
        {question.question}
        {question.multiSelect && question.options.length > 1 ? (
          <span className="font-normal text-fg-tertiary"> · pick any</span>
        ) : null}
      </p>
      {question.options.length === 0 ? (
        words
      ) : question.multiSelect ? (
        // A <fieldset> would bring its own border and legend to undo; the group only names the choices.
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
        <div role="group" aria-label={question.question} className={list}>
          {question.options.map((option) => (
            <Checkbox.Root
              key={option.label}
              checked={draft.choices.includes(option.label)}
              onCheckedChange={() => onChange(pick(question, draft, option.label))}
              className={row}
            >
              <span className={`${mark} rounded-[4px]`}>
                <Checkbox.Indicator className="text-accent-fg data-unchecked:hidden">
                  <Check size={10} strokeWidth={3} />
                </Checkbox.Indicator>
              </span>
              <OptionText label={option.label} description={option.description} />
            </Checkbox.Root>
          ))}
          {words}
        </div>
      ) : (
        <RadioGroup
          aria-label={question.question}
          value={draft.choices[0] ?? null}
          onValueChange={(value) => {
            if (typeof value !== "string") return;
            onChange(pick(question, draft, value));
            onPicked();
          }}
          className={list}
        >
          {question.options.map((option) => (
            <Radio.Root key={option.label} value={option.label} className={row}>
              <span className={`${mark} rounded-full`}>
                <Radio.Indicator className="size-1.5 rounded-full bg-accent-fg data-unchecked:hidden" />
              </span>
              <OptionText label={option.label} description={option.description} />
            </Radio.Root>
          ))}
          {words}
        </RadioGroup>
      )}
    </div>
  );
}

const tab =
  "flex h-6 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium text-fg-tertiary transition-colors outline-none select-none hover:text-fg-secondary focus-visible:ring-1 focus-visible:ring-line-strong data-active:bg-surface-selected data-active:text-fg-primary max-md:h-8 max-md:px-2.5 max-md:text-[13px]";

/** Ticks once a minute, so a card left open notices when its agent goes cold. */
function useMinute() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** How long the agent has waited, once answering it costs a cold start; nothing before then. */
function ColdNote({ askedAt }: { askedAt: number }) {
  const idle = coldFor(askedAt, useMinute());
  if (idle === undefined) return null;
  return (
    <span className="flex items-center gap-1 text-xs text-fg-tertiary">
      Asked {idle} ago · cache likely cold
      <InfoTip label="About answering late">
        Answering wakes the agent, and after this long its next turn re-reads the whole conversation without
        the prompt cache, which costs more. Skip closes the question without waking it: the agent hears with
        your next message.
      </InfoTip>
    </span>
  );
}

/**
 * An agent's open questions. Several are tabs, each ticked once answered; picking the one choice of a
 * question moves on to the next unanswered. `from` names who is asking where that isn't plain.
 * `askedAt` notes when an answer would wake an agent long gone cold.
 */
export function QuestionCard({
  questions,
  from,
  askedAt,
  onAnswer,
}: {
  questions: ReadonlyArray<Question>;
  from?: ReactNode;
  askedAt?: number;
  onAnswer?: AnswerQuestions | undefined;
}) {
  const [drafts, setDrafts] = useState(() => emptyDrafts(questions));
  const [index, setIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const answered = questions.map((question, at) => isAnswered(question, drafts[at]!));
  const complete = answered.every(Boolean);
  const question = questions[index]!;
  const several = questions.length > 1;
  /** The next question still unanswered after the one shown, wrapping round. */
  const nextOpen = (given: ReadonlyArray<boolean>) =>
    [...given.keys()].map((step) => (index + 1 + step) % given.length).find((at) => !given[at]);

  const send = async (response: QuestionResponse) => {
    if (sending || onAnswer === undefined) return;
    setSending(true);
    // On success the question closes and the card goes; on failure it stays to try again.
    if ((await onAnswer(response)) === false) setSending(false);
  };
  const submit = () => {
    if (complete) return void send(toResponse(drafts));
    const next = nextOpen(answered);
    if (answered[index] && next !== undefined) setIndex(next);
  };
  const change = (draft: Draft) => setDrafts(drafts.map((each, at) => (at === index ? draft : each)));
  const picked = () => {
    if (!several) return;
    const next = nextOpen(answered.map((given, at) => given || at === index));
    if (next !== undefined) setIndex(next);
  };

  return (
    // Ctrl Enter from any of the card's fields sends the answers; the fields take the keys themselves.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className={approvalShell}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="group"
      aria-label="Questions for you"
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          submit();
        }
      }}
    >
      {from}
      <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-fg-secondary max-md:text-[13px]">
        <MessageCircleQuestionMark size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
        {several ? (
          <Tabs.Root value={index} onValueChange={(value) => setIndex(Number(value))} className="min-w-0">
            <Tabs.List className="flex flex-wrap items-center gap-0.5">
              {questions.map((each, at) => (
                <Tabs.Tab key={at} value={at} className={tab}>
                  {answered[at] ? <Check size={11} strokeWidth={2.5} className="text-success" /> : null}
                  {each.header ?? `Question ${at + 1}`}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.Root>
        ) : (
          <span className="truncate font-medium text-fg-primary">{question.header ?? "Question"}</span>
        )}
      </div>
      <QuestionBody
        key={index}
        question={question}
        draft={drafts[index]!}
        onChange={change}
        onPicked={picked}
        onEnter={submit}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          onClick={submit}
          disabled={sending || !(complete || answered[index])}
          aria-keyshortcuts="Control+Enter"
          className={primary}
        >
          {complete || !several ? "Send answer" : "Next"}
        </Button>
        {several ? (
          <span className="px-1 text-xs text-fg-tertiary tabular-nums">
            {answered.filter(Boolean).length} of {questions.length} answered
          </span>
        ) : null}
        {/* The note sits beside Skip, the cheaper way out it explains. */}
        <div className="ml-auto flex items-center gap-1.5">
          {askedAt === undefined ? null : <ColdNote askedAt={askedAt} />}
          <Button onClick={() => void send({ outcome: "dismissed" })} disabled={sending} className={quiet}>
            Skip
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Questions that closed: what the user answered, or that nobody did. */
export function ClosedQuestions({
  questions,
  resolution,
}: {
  questions: ReadonlyArray<Question>;
  /** Absent when the agent stopped before anyone answered. */
  resolution: QuestionResolution | undefined;
}) {
  const outcome = resolution?.outcome ?? "expired";
  if (outcome !== "answered") {
    const [first] = questions;
    return (
      <div className="flex min-w-0 items-center gap-2 text-xs text-fg-tertiary">
        {outcome === "dismissed" ? (
          <X size={12} strokeWidth={2.5} className="shrink-0" />
        ) : (
          <Ban size={12} strokeWidth={2} className="shrink-0" />
        )}
        <span className="shrink-0">
          {outcome === "dismissed" ? "Question skipped" : "Not answered before the agent stopped"}
        </span>
        <span className="text-fg-disabled">·</span>
        <span className="truncate">{first?.header ?? first?.question}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-xs text-fg-tertiary">
        <MessageCircleQuestionMark size={12} strokeWidth={2} />
        {questions.length === 1 ? "You answered" : `You answered ${questions.length} questions`}
      </div>
      <dl className="ml-[5px] flex flex-col gap-2 border-l border-line-strong pl-3.5">
        {questions.map((question, at) => (
          <div key={at} className="flex flex-col gap-0.5">
            <dt className="text-xs leading-[1.45] text-fg-tertiary select-text">{question.question}</dt>
            <dd className="text-[13px] leading-[1.45] break-words whitespace-pre-wrap text-fg-primary select-text">
              {answerLine(resolution?.answers?.[at])}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
