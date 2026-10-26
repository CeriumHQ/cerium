CREATE TABLE `ui_events` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`at` integer NOT NULL,
	`payload` text NOT NULL,
	CONSTRAINT `fk_ui_events_id_events_id_fk` FOREIGN KEY (`id`) REFERENCES `events`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `ui_events_thread_at` ON `ui_events` (`thread_id`,`at`,`sequence`);