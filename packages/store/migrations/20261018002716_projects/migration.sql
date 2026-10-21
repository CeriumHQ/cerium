CREATE TABLE `projects` (
	`path` text PRIMARY KEY NOT NULL,
	`added_at` integer NOT NULL,
	`used_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `projects` (`path`, `added_at`, `used_at`)
SELECT `cwd`, min(`created_at`), max(`updated_at`) FROM `threads`
WHERE `mode` = 'work' AND `cwd` IS NOT NULL
GROUP BY `cwd`;
