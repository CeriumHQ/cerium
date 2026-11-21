import { saveAttachment } from "../backend/files.ts";
import { RegistryContext, useAtomSet } from "@effect/atom-react";
import { useContext, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { machineAtom } from "../backend/machine.ts";
import { draftsAtom, withDraft } from "../features/composer/drafts.ts";
import type { MessageBox } from "../features/composer/messageBox.ts";
import { previewBridge } from "../features/preview/model.ts";
import type { PromptDirection } from "../features/transcript/PromptStepper.tsx";
import { isNonThreadKey } from "../features/tabs/tabKinds.ts";
import { type PaneHandles } from "./ThreadPane.tsx";

import { messageOf } from "./workspaceErrors.ts";

export function useWorkspaceComposer(current: string, setActionError: (message: string) => void) {
  const registry = useContext(RegistryContext);
  /** Each pane's message box, by the thread it shows; the window reaches the open thread's. */
  const paneHandles = useRef(new Map<string, PaneHandles>());
  const [composerPanes, setComposerPanes] = useState<ReadonlySet<string>>(() => new Set());
  /** The open tab, as the window's handlers find it after each render. */
  const openKey = useRef<string>(undefined);
  /** The thread open last, which a file open since still writes to. */
  const lastThread = useRef<string>(undefined);
  const handlesOf = (key: string | undefined) =>
    key === undefined ? undefined : paneHandles.current.get(key);
  /** Puts the cursor in the open thread's message box. */
  const focusComposer = () => handlesOf(openKey.current)?.input.current?.focus();
  /** Puts a comment of the window's into the routed thread's draft, where the tray and the diffs read it. */
  const setDrafts = useAtomSet(draftsAtom);
  useEffect(
    () =>
      previewBridge()?.onPicked?.((threadId, element, png) => {
        if (registry.get(machineAtom) !== undefined) return;
        const id = crypto.randomUUID();
        void saveAttachment(registry, id, {
          name: `preview-${element.tag}-${id.slice(0, 8)}.png`,
          mediaType: "image/png",
          data: png,
        })
          .then((screenshot) => {
            setDrafts((drafts) =>
              withDraft(drafts, threadId, (draft) => ({
                ...draft,
                comments: [
                  ...(draft.comments ?? []),
                  { id, quote: element.selector, text: "", element: { ...element, screenshot } },
                ],
              })),
            );
          })
          .catch((error: unknown) => setActionError(messageOf(error)));
      }),
    [registry, setDrafts, setActionError],
  );
  const putComment = useEffectEvent((content: Parameters<MessageBox["comment"]>[0]) => {
    const key = lastThread.current ?? openKey.current;
    if (key === undefined) return;
    setDrafts((drafts) =>
      withDraft(drafts, key, (draft) => ({
        ...draft,
        comments: [...(draft.comments ?? []), { id: crypto.randomUUID(), ...content }],
      })),
    );
  });
  /**
   * What the rest of the window puts into the open thread's message box: with a file open, the
   * thread's open before it, else whichever thread shows.
   */
  const [messageBox] = useState((): MessageBox => {
    const box = () =>
      (
        handlesOf(openKey.current) ??
        handlesOf(lastThread.current) ??
        paneHandles.current.values().next().value
      )?.box;
    return {
      mention: (mention) => box()?.mention(mention),
      append: (content) => box()?.append(content),
      comment: (content) => putComment(content),
      openSide: (draft) => box()?.openSide(draft),
      key: () => box()?.key(),
    };
  });
  const [onPaneHandles] = useState(() => (key: string, handles: PaneHandles | undefined) => {
    if (handles) paneHandles.current.set(key, handles);
    else paneHandles.current.delete(key);
    const available = handles?.hasComposer === true;
    setComposerPanes((current) => {
      if (current.has(key) === available) return current;
      const next = new Set(current);
      if (available) next.add(key);
      else next.delete(key);
      return next;
    });
  });

  /** The draft the window's message box writes to: the open thread, or the one open last before its file. */
  const [lastThreadKey, setLastThreadKey] = useState<string | undefined>(
    isNonThreadKey(current) ? undefined : current,
  );
  if (!isNonThreadKey(current) && lastThreadKey !== current) setLastThreadKey(current);
  const routedDraftKey = isNonThreadKey(current) ? lastThreadKey : current;
  useLayoutEffect(() => {
    openKey.current = current;
    if (!isNonThreadKey(current)) lastThread.current = current;
  }, [current]);
  /** Asks for the cursor in the focused pane's message box, once it has rendered. */
  const [composerFocus, setComposerFocus] = useState(0);
  useEffect(() => {
    if (composerFocus === 0) return;
    const frame = requestAnimationFrame(focusComposer);
    return () => cancelAnimationFrame(frame);
  }, [composerFocus]);
  const openModels = () => handlesOf(openKey.current)?.composer.current?.openModels() ?? false;
  const steerNow = () => handlesOf(openKey.current)?.composer.current?.steerNow() ?? false;
  const stepPrompt = (direction: PromptDirection) =>
    handlesOf(openKey.current)?.prompts.current?.step(direction) ?? false;

  const scheduleFocus = () => setComposerFocus((count) => count + 1);
  return {
    openKey,
    routedDraftKey,
    lastThreadKey,
    handlesOf,
    composerPanes,
    focusComposer,
    messageBox,
    onPaneHandles,
    scheduleFocus,
    openModels,
    steerNow,
    stepPrompt,
  };
}

export type WorkspaceComposer = ReturnType<typeof useWorkspaceComposer>;
