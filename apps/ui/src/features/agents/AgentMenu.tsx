import { CircleStop, MessageSquareText, Pause, PanelRight } from "lucide-react";
import { useState, type ReactElement } from "react";

import { ConfirmDialog } from "../../components/ui/ConfirmDialog.tsx";
import { ContextMenuArea, MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import { agentMenuPlan, hasAgentMenu, type AgentMenuPlan, type AgentSummary } from "./model.ts";

/** What the menu's entries do; an entry whose action is absent isn't offered. */
export interface AgentActions {
  /** Selects the agent in the agents panel, opening it if needed. */
  readonly onShow?: (agentId: string) => void;
  /** Moves to the message box, which messages the lead. */
  readonly onMessageLead?: () => void;
  readonly onInterrupt?: (agentId: string) => void;
  readonly onStop?: (agentId: string) => void;
}

/** Stopping is confirmed first; what the dialog says depends on who is stopped. */
export function StopAgentDialog({
  agent,
  open,
  onOpenChange,
  onConfirm,
}: {
  agent: AgentSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const isLead = agent.parentId === undefined;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isLead ? "Stop the lead?" : `Stop ${agent.role}?`}
      description={
        isLead
          ? `${agent.model} will stop. Your next message in this thread starts it again where it left off.`
          : `${agent.model} will stop and can't be restarted. The lead carries on without it.`
      }
      confirmLabel="Stop agent"
      onConfirm={onConfirm}
    />
  );
}

/** The entries of an agent's menu, for the right-click menu and the details' "More actions" alike. */
export function AgentMenuItems({
  agent,
  plan,
  actions,
  onRequestStop,
}: {
  agent: AgentSummary;
  plan: AgentMenuPlan;
  actions: AgentActions;
  onRequestStop: () => void;
}) {
  return (
    <>
      {plan.show ? (
        <MenuItem icon={PanelRight} onClick={() => actions.onShow?.(agent.id)}>
          Show in agents panel
        </MenuItem>
      ) : null}
      {plan.message ? (
        <MenuItem icon={MessageSquareText} onClick={() => actions.onMessageLead?.()}>
          Message
        </MenuItem>
      ) : null}
      {plan.interrupt === "hidden" ? null : (
        <MenuItem
          icon={Pause}
          disabled={plan.interrupt === "disabled"}
          onClick={() => actions.onInterrupt?.(agent.id)}
        >
          Interrupt turn
        </MenuItem>
      )}
      {plan.stop ? (
        <>
          <MenuSeparator />
          <MenuItem icon={CircleStop} tone="danger" onClick={onRequestStop}>
            Stop agent…
          </MenuItem>
        </>
      ) : null}
    </>
  );
}

/**
 * Right-clicking `children` (one element standing for `agent`) opens the agent's menu. The menu acts
 * on that agent, whichever one is selected. An agent with nothing to offer doesn't claim the click.
 */
export function AgentMenuArea({
  agent,
  actions,
  card = false,
  children,
}: {
  agent: AgentSummary;
  actions: AgentActions;
  /** On a spawn card, which also offers to show the agent in the panel. */
  card?: boolean;
  children: ReactElement;
}) {
  const [confirmingStop, setConfirmingStop] = useState(false);
  const plan = agentMenuPlan(agent, {
    card: card && actions.onShow !== undefined,
    canMessage: actions.onMessageLead !== undefined,
  });
  if (!hasAgentMenu(plan)) return children;
  return (
    <>
      <ContextMenuArea
        menu={
          <AgentMenuItems
            agent={agent}
            plan={plan}
            actions={actions}
            onRequestStop={() => setConfirmingStop(true)}
          />
        }
      >
        {children}
      </ContextMenuArea>
      <StopAgentDialog
        agent={agent}
        open={confirmingStop}
        onOpenChange={setConfirmingStop}
        onConfirm={() => actions.onStop?.(agent.id)}
      />
    </>
  );
}
