CREATE TABLE `dismissed_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`source_url` text NOT NULL,
	`title` text,
	`company_name` text,
	`deleted_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dismissed_jobs_user_source_url` ON `dismissed_jobs` (`user_id`,`source_url`);