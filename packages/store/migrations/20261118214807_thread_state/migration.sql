CREATE TABLE `thread_states` (
	`thread_id` text PRIMARY KEY,
	`checkpoint` text NOT NULL,
	CONSTRAINT `fk_thread_states_thread_id_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `events_thread_artifact` ON `events` (`thread_id`) WHERE "events"."tag" = 'MessageCompleted' AND instr(json_extract("events"."payload", '$.text'), 'artifact') > 0;
--> statement-breakpoint
-- Keep the projection disposable across older writers, too. See THREAD_STATE_TAGS in @cerium/protocol.
CREATE TRIGGER `events_thread_state_invalidate` AFTER INSERT ON `events`
WHEN new.tag IN (
  'MessageCompleted',
  'UsageReported',
  'ContextReported',
  'ContextCompacted',
  'ConversationRewound',
  'TodosUpdated',
  'BackgroundTasksChanged',
  'SessionStarted',
  'ModelChanged',
  'LeadHandedOff',
  'AgentError',
  'PermissionRequested',
  'PermissionResolved',
  'SpawnApprovalRequested',
  'SpawnApprovalResolved',
  'QuestionAsked',
  'QuestionResolved',
  'MessageQueued',
  'TurnInput',
  'TurnCompleted',
  'MessageWithdrawn'
)
BEGIN
  DELETE FROM `thread_states` WHERE thread_id = new.thread_id;
END;
