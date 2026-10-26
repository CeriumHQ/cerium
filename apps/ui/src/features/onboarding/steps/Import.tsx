import type { PastSession } from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Check, Cloud } from "lucide-react";

import { accountAtom } from "../../../backend/atoms.ts";
import { ScrollArea } from "../../../components/ui/ScrollArea.tsx";
import { groupByProject } from "../../imports/model.ts";
import { SessionPicker, type SessionImport } from "../../imports/SessionPicker.tsx";
import { Eyebrow, Headline, Reveal } from "../parts.tsx";
import type { StepProps } from "../Welcome.tsx";

/**
 * The step a welcome takes only when the harnesses hold sessions of the user's: their projects, the
 * recent sessions ticked, to come in as threads that go on where they left off. The welcome's foot
 * imports them or skips.
 */
export function Import({
  number,
  titleId,
  sessions,
  importer,
}: StepProps & {
  readonly sessions: ReadonlyArray<PastSession>;
  readonly importer: SessionImport;
}) {
  const signedIn = AsyncResult.getOrElse(useAtomValue(accountAtom), () => undefined)?._tag === "SignedIn";
  const projects = groupByProject(sessions, importer.now).length;
  const { state } = importer;
  const busy = state._tag === "importing" || state._tag === "done";
  return (
    <div className="grid h-full grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-center gap-[clamp(24px,6vw,120px)] px-(--welcome-gutter) pb-[2vh]">
      <div className="flex flex-col items-start">
        <Eyebrow number={number}>Sessions</Eyebrow>
        <Headline
          id={titleId}
          lines={["Bring your", "sessions."]}
          className="text-[length:clamp(48px,min(6.6vw,11vh),112px)]"
        />
        <Reveal order={3} className="mt-[clamp(22px,4vh,40px)] flex max-w-[24rem] flex-col items-start gap-3">
          {state._tag === "done" ? (
            <p className="flex items-center gap-2 text-reading leading-relaxed text-fg-primary">
              <Check size={16} strokeWidth={2} className="text-success" />
              {state.count === 1 ? "1 thread" : `${state.count} threads`} in, each where you left it.
            </p>
          ) : (
            <p className="text-reading leading-relaxed text-fg-secondary">
              {sessions.length === 1 ? "1 session" : `${sessions.length} sessions`} in{" "}
              {projects === 1 ? "1 project" : `${projects} projects`}. Each comes in as a thread that picks up
              where it left off; older ones go to Archive.
            </p>
          )}
          {state._tag === "failed" ? <p className="text-meta text-error">{state.message}</p> : null}
          <p className="flex items-center gap-1.5 text-meta text-fg-tertiary">
            <Cloud size={13} strokeWidth={1.75} className="shrink-0" />
            {signedIn
              ? "They join your account's cloud copy."
              : "When you sign in, they join your account's cloud copy."}
          </p>
        </Reveal>
      </div>
      <Reveal order={3.5} className="min-h-0">
        <ScrollArea viewportClassName="max-h-[min(60vh,560px)]">
          <SessionPicker
            sessions={sessions}
            picked={importer.picked}
            onPick={importer.setPicked}
            now={importer.now}
            disabled={busy}
            rowClassName="bg-surface-raised shadow-raised backdrop-blur-xl"
          />
        </ScrollArea>
      </Reveal>
    </div>
  );
}
