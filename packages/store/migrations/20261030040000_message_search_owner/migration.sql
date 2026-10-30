-- The search index keeps its text in a table of its own, indexed by thread, so deleting a thread
-- removes its rows by rowid instead of reading every message's text to find them.
CREATE TABLE `message_search_text` (
  `id` integer PRIMARY KEY,
  `thread_id` text NOT NULL,
  `text` text
);
--> statement-breakpoint
CREATE INDEX `message_search_text_thread` ON `message_search_text` (`thread_id`);
--> statement-breakpoint
INSERT INTO `message_search_text` (`id`, `thread_id`, `text`)
  SELECT `rowid`, `thread_id`, `text` FROM `message_search` WHERE `thread_id` IS NOT NULL ORDER BY `rowid`;
--> statement-breakpoint
DROP TRIGGER `events_message_search`;
--> statement-breakpoint
DROP TRIGGER `threads_message_search`;
--> statement-breakpoint
DROP TABLE `message_search`;
--> statement-breakpoint
CREATE VIRTUAL TABLE `message_search` USING fts5(`text`, `thread_id` UNINDEXED, content = 'message_search_text', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2');
--> statement-breakpoint
INSERT INTO `message_search` (`message_search`) VALUES ('rebuild');
--> statement-breakpoint
CREATE TRIGGER `message_search_text_insert` AFTER INSERT ON `message_search_text` BEGIN
  INSERT INTO `message_search` (`rowid`, `text`, `thread_id`) VALUES (new.`id`, new.`text`, new.`thread_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `message_search_text_delete` AFTER DELETE ON `message_search_text` BEGIN
  INSERT INTO `message_search` (`message_search`, `rowid`, `text`, `thread_id`) VALUES ('delete', old.`id`, old.`text`, old.`thread_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `message_search_text_update` AFTER UPDATE ON `message_search_text` BEGIN
  INSERT INTO `message_search` (`message_search`, `rowid`, `text`, `thread_id`) VALUES ('delete', old.`id`, old.`text`, old.`thread_id`);
  INSERT INTO `message_search` (`rowid`, `text`, `thread_id`) VALUES (new.`id`, new.`text`, new.`thread_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `events_message_search` AFTER INSERT ON `events` WHEN new.`tag` IN ('MessageCompleted', 'TurnInput') BEGIN
  INSERT INTO `message_search_text` (`text`, `thread_id`)
    SELECT json_extract(new.`payload`, '$.text'), new.`thread_id` WHERE new.`tag` = 'MessageCompleted'
    UNION ALL
    SELECT json_extract(`item`.`value`, '$.text'), new.`thread_id` FROM json_each(new.`payload`, '$.items') AS `item`
    WHERE new.`tag` = 'TurnInput' AND json_extract(`item`.`value`, '$._tag') = 'FromUser';
END;
--> statement-breakpoint
CREATE TRIGGER `threads_message_search` AFTER DELETE ON `threads` BEGIN
  DELETE FROM `message_search_text` WHERE `thread_id` = old.`id`;
END;
