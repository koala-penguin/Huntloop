ALTER TABLE `cv_interviews` RENAME TO `cv_builders`;--> statement-breakpoint
ALTER TABLE `interview_answers` RENAME TO `cv_builder_answers`;--> statement-breakpoint
ALTER TABLE `interview_conversations` RENAME TO `cv_builder_conversations`;--> statement-breakpoint
ALTER TABLE `cv_builder_answers` RENAME COLUMN `interview_id` TO `cv_builder_id`;--> statement-breakpoint
ALTER TABLE `cv_builder_conversations` RENAME COLUMN `interview_id` TO `cv_builder_id`;--> statement-breakpoint
DROP INDEX `cv_interviews_user_status`;--> statement-breakpoint
DROP INDEX `interview_answers_interview`;--> statement-breakpoint
DROP INDEX `interview_conversations_interview`;--> statement-breakpoint
CREATE INDEX `cv_builders_user_status` ON `cv_builders` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `cv_builder_answers_builder` ON `cv_builder_answers` (`cv_builder_id`);--> statement-breakpoint
CREATE INDEX `cv_builder_conversations_builder` ON `cv_builder_conversations` (`cv_builder_id`);--> statement-breakpoint
UPDATE `conversations` SET `kind` = 'cv_builder' WHERE `kind` = 'cv_interview';--> statement-breakpoint
UPDATE `chat_actions` SET `kind` = 'cv_builder_polish' WHERE `kind` = 'interview_polish';--> statement-breakpoint
UPDATE `chat_actions` SET `kind` = 'cv_builder_form' WHERE `kind` = 'interview_form';--> statement-breakpoint
UPDATE `usage_log` SET `task` = 'cvBuilder' WHERE `task` = 'cvInterview';--> statement-breakpoint
UPDATE `app_settings` SET `value` = replace(`value`, '"cvInterview"', '"cvBuilder"') WHERE `value` LIKE '%"cvInterview"%';--> statement-breakpoint
UPDATE `tasks` SET `payload` = replace(`payload`, '"interviewId"', '"cvBuilderId"') WHERE `payload` LIKE '%"interviewId"%';--> statement-breakpoint
UPDATE `profile_versions` SET `data` = replace(`data`, '"source":"interview"', '"source":"cv_builder"') WHERE `data` LIKE '%"source":"interview"%';
