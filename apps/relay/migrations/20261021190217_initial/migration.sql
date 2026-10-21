-- Accounts made before migrations were Drizzle's have these tables already (`upgradeLegacy`).
CREATE TABLE IF NOT EXISTS `devices` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`channel` text NOT NULL,
	`version` text NOT NULL,
	`rpc_version` integer,
	`secret_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`approved_at` integer,
	`last_seen_at` integer,
	`installation` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `drafts` (
	`key` text PRIMARY KEY,
	`draft` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `event_batches` (
	`machine` text NOT NULL,
	`thread` text NOT NULL,
	`start` integer NOT NULL,
	`events` text NOT NULL,
	CONSTRAINT `event_batches_pk` PRIMARY KEY(`machine`, `thread`, `start`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `profile` (
	`id` integer PRIMARY KEY,
	`account_id` text NOT NULL,
	`name` text,
	`email` text,
	`image_url` text,
	CONSTRAINT "profile_single" CHECK("id" = 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `push` (
	`device` text PRIMARY KEY,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`kinds` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `read_state` (
	`thread` text PRIMARY KEY,
	`seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `threads` (
	`machine` text NOT NULL,
	`thread` text NOT NULL,
	`overview` text NOT NULL,
	`events` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `threads_pk` PRIMARY KEY(`machine`, `thread`)
);
