import { RegistryContext } from "@effect/atom-react";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useContext } from "react";

import { driveMachine } from "../backend/machine.ts";
import { WEB } from "../backend/target.ts";
import { UnreachableNotice } from "../features/account/AccountNotice.tsx";
import { presenceLabel } from "../features/account/model.ts";
import { UpdateNotice } from "../features/updates/UpdateNotice.tsx";
import { WhatsNewHost } from "../features/whatsnew/WhatsNewHost.tsx";
import { ImportDialogHost } from "../features/imports/ImportDialog.tsx";
import { Reveal } from "../components/Reveal.tsx";
import { BackendFailureNotice } from "../features/crash/BackendFailureNotice.tsx";
import { useCompact } from "./compact.ts";
import { Notice, NoticeSwap } from "./Notice.tsx";

import type { DrivenMachine } from "../backend/machine.ts";
import type { SoloThread } from "./threadWindow.ts";
import type { WorkspaceThreads } from "./useWorkspaceThreads.ts";
import { messageOf, type useWorkspaceErrors } from "./workspaceErrors.ts";

export function WorkspaceNotices({
  driven,
  solo,
  threads,
  errors,
}: {
  readonly driven: DrivenMachine | undefined;
  readonly solo: SoloThread | undefined;
  readonly threads: WorkspaceThreads;
  readonly errors: ReturnType<typeof useWorkspaceErrors>;
}) {
  const registry = useContext(RegistryContext);
  const { connection, drivenDevice, backendFailure, threadsResult } = threads;
  // A phone says how the line stands in its bar and the thread's sheet, leaving the transcript its room.
  const compact = useCompact();
  /** The notices over the open thread's conversation, each dropping in and folding back up. */
  return (
    <>
      <Reveal shift={-6} className="shrink-0" carry inertWhileEntering>
        {connection === "unreachable" && driven !== undefined ? (
          compact ? null : (
            <NoticeSwap kind="remote">
              <UnreachableNotice
                machine={driven.name}
                presence={drivenDevice && !drivenDevice.online ? presenceLabel(drivenDevice) : undefined}
                onBack={WEB ? undefined : () => driveMachine(registry, undefined)}
              />
            </NoticeSwap>
          )
        ) : backendFailure !== undefined && driven === undefined ? (
          <NoticeSwap kind="crash">
            <BackendFailureNotice failure={backendFailure} />
          </NoticeSwap>
        ) : connection === "unreachable" && !WEB ? (
          compact ? null : (
            <NoticeSwap kind="reconnecting">
              <Notice tone="attention">
                Reconnecting to Cerium's backend…
                {import.meta.env.DEV ? (
                  <>
                    {" "}
                    Start it with <code>bun run dev</code>.
                  </>
                ) : null}
              </Notice>
            </NoticeSwap>
          )
        ) : AsyncResult.isFailure(threadsResult) ? (
          <NoticeSwap kind="threads">
            <Notice tone="error" clamp>
              {messageOf(Cause.squash(threadsResult.cause))}
            </Notice>
          </NoticeSwap>
        ) : null}
      </Reveal>
      {/* The main window has the app's own news; a thread's own window, its thread's. */}
      {solo ? null : (
        <>
          {WEB ? null : <UpdateNotice />}
          <WhatsNewHost />
          <ImportDialogHost />
        </>
      )}
      <Reveal shift={-6} className="shrink-0">
        {errors.error ? (
          <Notice tone="error" clamp onDismiss={errors.dismiss}>
            {errors.error}
          </Notice>
        ) : null}
      </Reveal>
    </>
  );
}
