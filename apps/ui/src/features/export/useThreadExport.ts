import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ThreadId } from "@cerium/protocol";
import { AsyncResult, Atom } from "effect/reactivity";

import { Backend } from "../../backend/client.ts";
import { threadsAtom } from "../../backend/atoms.ts";
import { shellBridge } from "../../backend/shell.ts";
import { leadOf, modelLabel } from "../../backend/view.ts";
import { useModels } from "../composer/models.ts";
import { buildTranscript } from "../transcript/model.ts";
import { artifactFileName, download } from "../transcript/artifactExport.ts";
import { copyText } from "../transcript/menus.ts";
import { conversationDocument, type ExportFormat } from "./conversation.ts";

// Exporting a thread: its lead's conversation, read from the backend, written out as Markdown or text,
// then saved (through the desktop's Save dialog, or a download in the browser) or copied.

/** What the user asked for: a file in a format, or the Markdown on the clipboard. */
export type ExportAction = ExportFormat | "copy";

/** A thread's events without the images its tool outputs carry, which a document only names by path. */
const readThreadEvents = Backend.runtime.fn<{ readonly payload: { readonly threadId: ThreadId } }>()(
  ({ payload }) =>
    Backend.use((client) => client("ThreadEvents", { threadId: payload.threadId, withoutImages: true })),
);

/** Why the last export failed, for the notice bar; cleared when the next one starts. */
export const exportFailureAtom = Atom.make<string | undefined>(undefined);

/**
 * Exports the thread with `threadId` (one listed in the window). Resolves once the file is saved or
 * the text copied; a failure is shown in the notice bar rather than thrown.
 */
export const useThreadExport = () => {
  const readEvents = useAtomSet(readThreadEvents, { mode: "promise" });
  const threads = useAtomValue(threadsAtom);
  const models = useModels();
  const setFailure = useAtomSet(exportFailureAtom);
  return async (threadId: string, action: ExportAction): Promise<void> => {
    const overview = AsyncResult.isSuccess(threads)
      ? threads.value.find((candidate) => candidate.thread.id === threadId)
      : undefined;
    const lead = overview ? leadOf(overview.agents) : undefined;
    setFailure(undefined);
    if (overview === undefined || lead === undefined) {
      setFailure("This thread can't be read right now, so it wasn't exported.");
      return;
    }
    try {
      const events = await readEvents({ payload: { threadId: overview.thread.id } });
      const format = action === "text" ? "text" : "markdown";
      const text = conversationDocument(
        {
          title: overview.thread.title,
          folder: overview.thread.cwd,
          blocks: buildTranscript(events.filter((event) => event.agentId === lead.id)),
          modelName: (model, provider) => modelLabel(models, provider ?? lead.provider, model),
          initialModel: modelLabel(models, lead.provider, lead.model),
        },
        format,
      );
      if (action === "copy") {
        copyText(text);
        return;
      }
      const name = artifactFileName(overview.thread.title, format === "markdown" ? "md" : "txt");
      const bridge = shellBridge();
      if (bridge?.saveText) await bridge.saveText(text, name, format);
      else
        download(
          new Blob([text], { type: `text/${format === "markdown" ? "markdown" : "plain"};charset=utf-8` }),
          name,
        );
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The thread couldn't be exported.");
    }
  };
};
