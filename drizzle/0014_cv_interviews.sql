CREATE TABLE `cv_interviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`status` text DEFAULT 'in_progress' NOT NULL,
	`depth` text DEFAULT 'full' NOT NULL,
	`personas` text DEFAULT '[]' NOT NULL,
	`target_country` text,
	`language` text DEFAULT 'en' NOT NULL,
	`stage` text DEFAULT 'setup' NOT NULL,
	`stages` text DEFAULT '{}' NOT NULL,
	`form` text DEFAULT '{}' NOT NULL,
	`profile_version` integer,
	`base_doc_id` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cv_interviews_user_status` ON `cv_interviews` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `interview_answers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`interview_id` integer NOT NULL,
	`stage` text NOT NULL,
	`topic` text NOT NULL,
	`experience_ref` text,
	`question` text DEFAULT '' NOT NULL,
	`quote` text NOT NULL,
	`private` integer DEFAULT false NOT NULL,
	`origin` text NOT NULL,
	`message_id` integer,
	`superseded_by` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`interview_id`) REFERENCES `cv_interviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `interview_answers_interview` ON `interview_answers` (`interview_id`);--> statement-breakpoint
CREATE TABLE `interview_conversations` (
	`conversation_id` integer PRIMARY KEY NOT NULL,
	`interview_id` integer NOT NULL,
	`stage` text NOT NULL,
	`experience_ref` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`interview_id`) REFERENCES `cv_interviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `interview_conversations_interview` ON `interview_conversations` (`interview_id`);