ALTER TABLE `conversations` ADD `provider` text DEFAULT 'api' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `provider_session` text;--> statement-breakpoint
ALTER TABLE `usage_log` ADD `via` text DEFAULT 'api' NOT NULL;