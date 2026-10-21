CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`parent_id` text,
	`role` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`access` text NOT NULL,
	`state` text NOT NULL,
	`provider_session_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agents_thread` ON `agents` (`thread_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`at` integer NOT NULL,
	`tag` text NOT NULL,
	`payload` text NOT NULL,
	`raw` text,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_agent_sequence` ON `events` (`agent_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `events_thread_at` ON `events` (`thread_id`,`at`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`mode` text NOT NULL,
	`cwd` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
