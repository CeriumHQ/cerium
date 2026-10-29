CREATE TABLE `event_order` (
  `position` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `id` text NOT NULL UNIQUE REFERENCES `events`(`id`) ON DELETE CASCADE,
  `thread_id` text NOT NULL,
  `at` integer NOT NULL,
  `sequence` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_order_history` ON `event_order` (`thread_id`, `at`, `sequence`, `id`);
--> statement-breakpoint
CREATE INDEX `event_order_resume` ON `event_order` (`thread_id`, `position`);
--> statement-breakpoint
-- Metadata only: no canonical payloads are decoded or rewritten during migration.
INSERT INTO `event_order` (`id`, `thread_id`, `at`, `sequence`)
SELECT `id`, `thread_id`, `at`, `sequence` FROM `events` ORDER BY rowid;
--> statement-breakpoint
CREATE TRIGGER `events_history_insert` AFTER INSERT ON `events` BEGIN
  INSERT INTO `event_order` (`id`, `thread_id`, `at`, `sequence`)
  VALUES (new.id, new.thread_id, new.at, new.sequence);
END;
