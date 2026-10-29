CREATE TABLE `assistants` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`code_hash` text,
	`code_challenge` text,
	`code_expires_at` integer,
	`access_hash` text,
	`access_expires_at` integer,
	`refresh_hash` text
);
