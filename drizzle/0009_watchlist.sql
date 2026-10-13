CREATE TABLE `board_openings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`watch_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`location` text,
	`department` text,
	`url` text NOT NULL,
	`ats_url` text NOT NULL,
	`posted_at` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`closed_at` integer,
	`matched` integer DEFAULT false NOT NULL,
	`match_score` real,
	`match_reason` text,
	`job_id` integer,
	FOREIGN KEY (`watch_id`) REFERENCES `watched_boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `board_openings_external` ON `board_openings` (`watch_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `watched_boards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`company_id` integer,
	`name` text NOT NULL,
	`ats_type` text NOT NULL,
	`board` text NOT NULL,
	`eu` integer DEFAULT false NOT NULL,
	`auto_check` integer DEFAULT true NOT NULL,
	`last_checked_at` integer,
	`next_check_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `watched_boards_user` ON `watched_boards` (`user_id`);--> statement-breakpoint
ALTER TABLE `searches` ADD `saved` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `searches` ADD `name` text;--> statement-breakpoint
ALTER TABLE `searches` ADD `schedule` text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE `searches` ADD `next_run_at` integer;--> statement-breakpoint
ALTER TABLE `searches` ADD `schedule_note` text;