import type { PastSession } from "@cerium/protocol";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Check, LoaderCircle } from "lucide-react";

import { pastSessionsAtom } from "../../backend/atoms.ts";
import { DialogButton, FormDialog } from "../../components/ui/FormDialog.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { SessionPicker, useSessionImport } from "./SessionPicker.tsx";
import { importOpenAtom } from "./state.ts";

/**
 * Owns the command palette's "Import sessions…" dialog: the sessions the harnesses list, by project,
 * to bring in as threads. They're listed afresh each time it opens.
 */
export function ImportDialogHost() {
  const [open, setOpen] = useAtom(importOpenAtom);
  return open ? <ImportDialog onClose={() => setOpen(false)} /> : null;
}

function ImportDialog({ onClose }: { readonly onClose: () => void }) {
  const result = useAtomValue(pastSessionsAtom);
  const sessions = AsyncResult.getOrElse(result, (): ReadonlyArray<PastSession> => []);
  const importer = useSessionImport(sessions);
  const { state, picked } = importer;
  const done = state._tag === "done";
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      wide
      title="Import sessions"
      description="Bring sessions you had with your harnesses in as threads that pick up where they left off."
      onSubmit={() => (done ? onClose() : void importer.start())}
      actions={
        done ? (
          <DialogButton tone="primary" type="submit">
            Done
          </DialogButton>
        ) : (
          <DialogButton
            tone="primary"
            type="submit"
            disabled={picked.size === 0 || state._tag === "importing"}
          >
            {state._tag === "importing" ? "Importing…" : `Import ${picked.size}`}
          </DialogButton>
        )
      }
    >
      {done ? (
        <p className="flex items-center gap-2 text-body text-fg-primary">
          <Check size={15} strokeWidth={2} className="text-success-text" />
          {state.count === 1 ? "1 thread" : `${state.count} threads`} in, each where you left it.
        </p>
      ) : AsyncResult.isInitial(result) || (result.waiting && sessions.length === 0) ? (
        <p className="flex items-center gap-2 py-6 text-body text-fg-tertiary">
          <LoaderCircle size={14} strokeWidth={1.75} className="animate-spin" />
          Looking through your harnesses…
        </p>
      ) : AsyncResult.isFailure(result) ? (
        <p className="py-2 text-body text-error-text">This machine couldn't list its harnesses' sessions.</p>
      ) : sessions.length === 0 ? (
        <p className="py-2 text-body text-fg-tertiary">No sessions left to bring in.</p>
      ) : (
        <>
          <ScrollArea viewportClassName="max-h-[min(52vh,480px)]">
            <SessionPicker
              sessions={sessions}
              picked={picked}
              onPick={importer.setPicked}
              now={importer.now}
              disabled={state._tag === "importing"}
            />
          </ScrollArea>
          {state._tag === "failed" ? <p className="text-meta text-error-text">{state.message}</p> : null}
        </>
      )}
    </FormDialog>
  );
}
