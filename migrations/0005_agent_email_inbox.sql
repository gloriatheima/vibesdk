-- Per-session email inbox. Populated by the email() Worker handler when
-- a message arrives via Cloudflare Email Routing; read by email_inbox /
-- email_read tools.
CREATE TABLE IF NOT EXISTS `agent_inbox` (
	`message_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`from_addr`  text NOT NULL,
	`to_addr`    text NOT NULL,
	`subject`    text NOT NULL DEFAULT '(no subject)',
	`received_at_ms` integer NOT NULL,
	`size_bytes`     integer NOT NULL DEFAULT 0,
	`body_text`  text,
	`body_html`  text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_inbox_session_received`
	ON `agent_inbox` (`session_id`, `received_at_ms` DESC);
--> statement-breakpoint

-- Outbound messages sent by email_send. The Message-ID encodes the
-- session so replies route back to the same session.
CREATE TABLE IF NOT EXISTS `agent_sent_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`to_addr`    text NOT NULL,
	`sent_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_sent_messages_session`
	ON `agent_sent_messages` (`session_id`);
--> statement-breakpoint

-- Agent email aliases. Maps inbound recipient addresses to session IDs.
-- Each alias is the local-part of the address (e.g. "agent-abc123").
CREATE TABLE IF NOT EXISTS `agent_email_aliases` (
	`alias`      text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_email_aliases_session`
	ON `agent_email_aliases` (`session_id`);
