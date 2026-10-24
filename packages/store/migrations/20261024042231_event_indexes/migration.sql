CREATE INDEX `events_thread_tag` ON `events` (`thread_id`,`tag`);--> statement-breakpoint
CREATE INDEX `events_tag_at` ON `events` (`tag`,`at`);