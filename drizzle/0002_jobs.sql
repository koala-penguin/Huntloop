CREATE TABLE `ai_texts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` integer NOT NULL,
	`lang` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_texts_owner` ON `ai_texts` (`owner_type`,`owner_id`,`lang`);--> statement-breakpoint
CREATE TABLE `assessments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`analysis_id` integer NOT NULL,
	`profile_version` integer NOT NULL,
	`profile_hash` text NOT NULL,
	`prompt_version` integer NOT NULL,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`kind` text DEFAULT 'deep' NOT NULL,
	`language` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`analysis_id`) REFERENCES `posting_analyses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assessments_key` ON `assessments` (`analysis_id`,`profile_hash`,`prompt_version`,`model`,`effort`,`kind`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`domain` text,
	`ats_type` text,
	`ats_slug` text,
	`country` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `companies_user_name` ON `companies` (`user_id`,`normalized_name`);--> statement-breakpoint
CREATE TABLE `job_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`mime` text NOT NULL,
	`file_name` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `job_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`type` text NOT NULL,
	`from_value` text,
	`to_value` text,
	`note` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`company_id` integer,
	`source` text NOT NULL,
	`source_url` text,
	`apply_url` text,
	`title` text,
	`company_name` text,
	`location_text` text,
	`city` text,
	`country` text,
	`workplace` text,
	`employment_type` text,
	`posted_at` integer,
	`closes_at` integer,
	`raw_text` text,
	`description` text,
	`description_is_full` integer DEFAULT true NOT NULL,
	`description_hash` text,
	`intake_status` text DEFAULT 'processing' NOT NULL,
	`intake_error` text,
	`intake` text,
	`analysis_id` integer,
	`assessment_id` integer,
	`answers` text,
	`status` text DEFAULT 'new' NOT NULL,
	`score` real,
	`tier` text,
	`eligibility` text,
	`confidence` text,
	`score_data` text,
	`notes` text,
	`dedupe_key` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jobs_user_status` ON `jobs` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `jobs_user_dedupe` ON `jobs` (`user_id`,`dedupe_key`);--> statement-breakpoint
CREATE TABLE `posting_analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text_hash` text NOT NULL,
	`prompt_version` integer NOT NULL,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `posting_analyses_key` ON `posting_analyses` (`text_hash`,`prompt_version`,`model`);