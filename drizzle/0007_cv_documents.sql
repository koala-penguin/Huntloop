CREATE TABLE `cv_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`job_id` integer,
	`kind` text NOT NULL,
	`version` integer NOT NULL,
	`profile_version` integer NOT NULL,
	`profile_hash` text NOT NULL,
	`analysis_id` integer,
	`language` text NOT NULL,
	`market` text,
	`model` text NOT NULL,
	`prompt_version` integer NOT NULL,
	`plan` text,
	`content` text NOT NULL,
	`flags` text NOT NULL,
	`checks` text,
	`edits` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cv_documents_owner` ON `cv_documents` (`user_id`,`kind`,`job_id`,`version`);