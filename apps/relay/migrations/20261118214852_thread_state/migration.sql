CREATE TABLE `thread_state_batches` (
	`machine` text NOT NULL,
	`thread` text NOT NULL,
	`view` text NOT NULL,
	`start` integer NOT NULL,
	`events` text NOT NULL,
	CONSTRAINT `thread_state_batches_pk` PRIMARY KEY(`machine`, `thread`, `view`, `start`)
);
--> statement-breakpoint
CREATE TABLE `thread_state_chunks` (
	`machine` text NOT NULL,
	`thread` text NOT NULL,
	`part` integer NOT NULL,
	`json` text NOT NULL,
	CONSTRAINT `thread_state_chunks_pk` PRIMARY KEY(`machine`, `thread`, `part`)
);
--> statement-breakpoint
ALTER TABLE `threads` ADD `state_events` integer;