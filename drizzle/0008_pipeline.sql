ALTER TABLE `job_events` ADD `data` text;--> statement-breakpoint
CREATE INDEX `job_events_job` ON `job_events` (`job_id`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `applied_at` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `status_changed_at` integer;