import {
  expandPromptTemplate,
  matchPrompts,
  parsePromptTemplate,
  visiblePrompts,
  type Mention,
  type PromptContext,
  type PromptTemplate,
} from "@cerium/protocol";
import { AsyncResult } from "effect/reactivity";
import { ArrowRightLeft, MessageCircleQuestionMark, Square } from "lucide-react";
import { useState, type KeyboardEvent, type RefObject } from "react";

import { bindingFor } from "../../lib/shortcuts.ts";
import { matchCommands, type PaletteCommand } from "../palette/palette.ts";
import { queryWords } from "../threads/threadSearch.ts";
import { type Draft, type Segment, type Trigger } from "./draft.ts";
import { MentionMenu, useMentionOptions } from "./MentionMenu.tsx";
import { type PromptEditorHandle } from "./PromptEditor.tsx";
import { PromptParameters } from "./PromptParameters.tsx";
import { projectName } from "./projectList.ts";
import { SlashMenu, slashGroups, type SlashEntry } from "./SlashMenu.tsx";

import type { ComposerTarget } from "./composerTypes.ts";
import { ComposerMenu } from "./ComposerMenu.tsx";
import type { StartChoices } from "./useStartChoices.ts";
import type { ShortcutId } from "../../lib/shortcuts.ts";

/**
 * Whether two mention triggers are one: the same character at the same place, with the same query.
 * Out here because the React Compiler skips a component whose condition chains optional comparisons.
 */
const sameTrigger = (a: Trigger | undefined, b: Trigger | undefined) =>
  a?.char === b?.char && a?.start === b?.start && a?.query === b?.query;

/** The `/` list's entry that writes `/btw `. */
const SIDE_QUESTION_COMMAND = "slash-side-question";
const SWITCH_MODEL_COMMAND = "slash-switch-model";

export function useComposerMenus({
  target,
  draft,
  draftKey,
  storedDraft,
  browsing,
  editor,
  input,
  start,
  bindings,
  running,
  onStop,
  slashCommands,
  offersSwitch,
  onOpenModels,
}: {
  readonly target: ComposerTarget;
  readonly draft: Draft;
  readonly draftKey: string;
  readonly storedDraft: Draft;
  readonly browsing: boolean;
  readonly editor: RefObject<PromptEditorHandle | null>;
  readonly input: RefObject<HTMLDivElement | null>;
  readonly start: StartChoices;
  readonly bindings: Readonly<Record<ShortcutId, string>>;
  readonly running: boolean;
  readonly onStop: () => void;
  readonly slashCommands: ReadonlyArray<PaletteCommand>;
  readonly offersSwitch: boolean;
  readonly onOpenModels: () => void;
}) {
  const { isNew, starting, settings, branch, checkoutBranch, workFolder } = start;
  const [trigger, setTrigger] = useState<Trigger>();
  /** A tag whose list Esc closed; it stays closed until another tag starts. */
  const [dismissed, setDismissed] = useState<Trigger>();
  const [active, setActive] = useState(0);
  const [parameters, setParameters] = useState<{
    readonly key: string;
    readonly draft: ReadonlyArray<Segment>;
    readonly prompt: string;
    readonly template: PromptTemplate;
    readonly context: PromptContext;
    readonly replace: (text: string, cursor?: number) => void;
    readonly trigger: Trigger;
  }>();
  const filling =
    parameters?.key === draftKey && parameters.draft === storedDraft.segments ? parameters : undefined;
  if (parameters !== undefined && filling === undefined) setParameters(undefined);
  // `@` tags files in the thread's folder; `$` the skills of the harness the message goes to.
  const sources = {
    folder: workFolder,
    provider: target.kind === "thread" ? target.provider : starting[0]?.provider,
    chat: target.kind === "thread" ? target.folder === undefined : target.mode === "chat",
  };
  // Esc shuts a list for the one `@`, `$` or `/` it was opened by; once that is gone, as when the
  // message is cleared, the next one opens its list again.
  if (
    dismissed !== undefined &&
    (trigger === undefined || trigger.char !== dismissed.char || trigger.start !== dismissed.start)
  ) {
    setDismissed(undefined);
  }
  const menuTrigger =
    !browsing &&
    filling === undefined &&
    trigger !== undefined &&
    trigger.char !== "/" &&
    !(trigger.char === dismissed?.char && trigger.start === dismissed.start)
      ? trigger
      : undefined;
  const results = useMentionOptions(menuTrigger, sources);
  // A `$` that matches no skill is most likely just a dollar sign ("$5"), so its list stays shut.
  const menuOpen =
    menuTrigger !== undefined &&
    (menuTrigger.char === "@" || menuTrigger.query === "" || results.options.length > 0);
  const activeIndex = Math.min(active, Math.max(0, results.options.length - 1));

  // `/` at the start of the message: the user's saved prompts, then the actions that answer here.
  const slashTrigger = !browsing && filling === undefined && trigger?.char === "/" ? trigger : undefined;
  const slashOpen =
    slashTrigger !== undefined &&
    !(slashTrigger.char === dismissed?.char && slashTrigger.start === dismissed.start);
  const storedPrompts = AsyncResult.isSuccess(settings) ? settings.value.prompts.prompts : [];
  const slashPrompts = slashOpen
    ? matchPrompts(visiblePrompts(storedPrompts, sources.folder), slashTrigger?.query ?? "")
    : [];
  const pick = (mention: Mention) => {
    editor.current?.insertMention(mention);
    setActive(0);
  };

  /** A `/` entry: a saved prompt's text in place of the command, or the action run at once. */
  const pickSlash = (entry: SlashEntry) => {
    if (entry.kind === "prompt") {
      const replace = editor.current?.captureSlashReplacement();
      if (replace && slashTrigger) {
        const template = parsePromptTemplate(entry.prompt.text);
        const workspace = draft.start?.workspace;
        const currentBranch =
          target.kind === "thread"
            ? (branch ?? target.worktree?.branch)
            : (workspace?.branch ?? workspace?.existingBranch ?? checkoutBranch ?? branch);
        const project = target.kind === "thread" ? (target.worktree?.project ?? workFolder) : workFolder;
        const context: PromptContext = {
          ...(currentBranch === undefined ? {} : { branch: currentBranch }),
          ...(project === undefined ? {} : { project: projectName(project) }),
        };
        if (template.parameters.length === 0) {
          const expanded = expandPromptTemplate(template, context);
          replace(expanded.text, expanded.cursor);
        } else {
          setParameters({
            key: draftKey,
            draft: storedDraft.segments,
            prompt: entry.prompt.name,
            template,
            context,
            replace,
            trigger: slashTrigger,
          });
        }
      }
    } else if (entry.command.id === SIDE_QUESTION_COMMAND) {
      editor.current?.captureSlashReplacement()?.("/btw ");
    } else {
      if (entry.command.id === SWITCH_MODEL_COMMAND) editor.current?.captureSlashReplacement()?.("");
      entry.command.run();
    }
    setTrigger(undefined);
    setActive(0);
  };

  // Switching models and stopping the turn live in the box, beside the palette's actions.
  const slashLocal: ReadonlyArray<PaletteCommand> = [
    ...(target.kind === "thread" && target.onAskSide
      ? [
          {
            id: SIDE_QUESTION_COMMAND,
            group: "Actions" as const,
            label: "Side question",
            icon: MessageCircleQuestionMark,
            keywords: "btw ask aside quick",
            // Picking it writes `/btw ` (`pickSlash`); the box's ref stays out of render.
            run: () => undefined,
          },
        ]
      : []),
    ...(isNew || offersSwitch
      ? [
          {
            id: SWITCH_MODEL_COMMAND,
            group: "Actions" as const,
            label: "Switch model",
            icon: ArrowRightLeft,
            keywords: "model effort speed",
            keys: bindingFor(bindings, "open-model-picker"),
            run: onOpenModels,
          },
        ]
      : []),
    ...(running
      ? [
          {
            id: "slash-stop",
            group: "Actions" as const,
            label: "Stop this turn",
            icon: Square,
            keywords: "interrupt cancel halt",
            run: onStop,
          },
        ]
      : []),
  ];
  const slashActions = slashOpen
    ? matchCommands([...slashLocal, ...slashCommands], queryWords(slashTrigger?.query ?? ""))
    : [];
  const slashActive = Math.min(active, Math.max(0, slashPrompts.length + slashActions.length - 1));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, plain: boolean) => {
    const count = results.options.length;
    if (menuOpen && count > 0 && !event.nativeEvent.isComposing) {
      if (plain && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        setActive((activeIndex + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && plain) {
        event.preventDefault();
        pick(results.options[activeIndex]!.mention);
        return true;
      }
    }
    // The `/` list answers the same keys: arrows move, Enter or Tab runs, Esc closes it.
    const slashCount = slashPrompts.length + slashActions.length;
    if (slashOpen && slashCount > 0 && !event.nativeEvent.isComposing) {
      if (plain && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        setActive((slashActive + (event.key === "ArrowDown" ? 1 : slashCount - 1)) % slashCount);
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && plain) {
        event.preventDefault();
        pickSlash(
          slashActive < slashPrompts.length
            ? { kind: "prompt", prompt: slashPrompts[slashActive]! }
            : { kind: "action", command: slashActions[slashActive - slashPrompts.length]! },
        );
        return true;
      }
    }
    if ((menuOpen || slashOpen) && event.key === "Escape") {
      event.preventDefault();
      setDismissed(menuTrigger ?? slashTrigger);
      return true;
    }

    return false;
  };
  return {
    open: menuOpen || slashOpen,
    filling,
    clearParameters: () => setParameters(undefined),
    clearTrigger: () => setTrigger(undefined),
    setTrigger: (next: Trigger | undefined) => {
      if (!sameTrigger(next, trigger)) setActive(0);
      setTrigger(next);
    },
    onKeyDown,
    activeOption:
      menuOpen && results.options.length > 0
        ? `mention-option-${activeIndex}`
        : slashOpen && slashPrompts.length + slashActions.length > 0
          ? `slash-option-${slashActive}`
          : undefined,
    mentionMenu: (
      <ComposerMenu>
        {menuOpen ? (
          <MentionMenu
            trigger={menuTrigger}
            sources={sources}
            results={results}
            active={activeIndex}
            onActive={setActive}
            onPick={pick}
          />
        ) : null}
      </ComposerMenu>
    ),
    slashMenu: (
      <ComposerMenu>
        {slashOpen ? (
          <SlashMenu
            groups={slashGroups(slashPrompts, slashActions)}
            query={slashTrigger?.query ?? ""}
            active={slashActive}
            onActive={setActive}
            onPick={pickSlash}
          />
        ) : null}
      </ComposerMenu>
    ),
    parameters: filling ? (
      <PromptParameters
        prompt={filling.prompt}
        parameters={filling.template.parameters}
        onInsert={(values) => {
          const expanded = expandPromptTemplate(filling.template, filling.context, values);
          setParameters(undefined);
          filling.replace(expanded.text, expanded.cursor);
          setTrigger(undefined);
        }}
        onCancel={() => {
          setParameters(undefined);
          input.current?.focus({ preventScroll: true });
          setTrigger(filling.trigger);
          setDismissed(filling.trigger);
        }}
      />
    ) : null,
  };
}
