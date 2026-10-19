CREATE VIRTUAL TABLE `message_search` USING fts5(`text`, `thread_id` UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `events_message_search` AFTER INSERT ON `events` WHEN new.`tag` IN ('MessageCompleted', 'TurnInput') BEGIN
  INSERT INTO `message_search` (`text`, `thread_id`)
    SELECT json_extract(new.`payload`, '$.text'), new.`thread_id` WHERE new.`tag` = 'MessageCompleted'
    UNION ALL
    SELECT json_extract(`item`.`value`, '$.text'), new.`thread_id` FROM json_each(new.`payload`, '$.items') AS `item`
    WHERE new.`tag` = 'TurnInput' AND json_extract(`item`.`value`, '$._tag') = 'FromUser';
END;
--> statement-breakpoint
CREATE TRIGGER `threads_message_search` AFTER DELETE ON `threads` BEGIN
  DELETE FROM `message_search` WHERE `thread_id` = old.`id`;
END;
--> statement-breakpoint
INSERT INTO `message_search` (`text`, `thread_id`)
  SELECT json_extract(`payload`, '$.text'), `thread_id` FROM `events` WHERE `tag` = 'MessageCompleted'
  UNION ALL
  SELECT json_extract(`item`.`value`, '$.text'), `events`.`thread_id` FROM `events`, json_each(`events`.`payload`, '$.items') AS `item`
  WHERE `events`.`tag` = 'TurnInput' AND json_extract(`item`.`value`, '$._tag') = 'FromUser';
