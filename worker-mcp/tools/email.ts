import type { McpTool } from '../../worker/agents/universal/mcp/types';
import type { ToolServerEnv } from '../env';
import { truncate, str } from '../utils';

export const TOOL_DEFINITIONS: McpTool[] = [
	{
		name: 'email_send',
		description: 'Send an outbound email via the SEND_EMAIL binding.',
		inputSchema: {
			type: 'object',
			properties: {
				to: { type: 'string', description: 'Recipient email address' },
				subject: { type: 'string', description: 'Email subject' },
				body: { type: 'string', description: 'Plain text body' },
				from: { type: 'string', description: 'Sender address (optional, defaults to EMAIL_FROM)' },
				html: { type: 'string', description: 'HTML body (optional)' },
			},
			required: ['to', 'subject', 'body'],
		},
	},
	{
		name: 'email_inbox',
		description: "List received emails for this agent session.",
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'string', description: 'Max number of messages to return (default 25, max 50)' },
				since_ms: { type: 'string', description: 'Only messages received after this Unix timestamp (ms)' },
			},
		},
	},
	{
		name: 'email_read',
		description: "Read the full body of an inbox message by its message_id.",
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'message_id from email_inbox' },
			},
			required: ['id'],
		},
	},
	{
		name: 'email_get_address',
		description: 'Get or create the unique inbound email address for this session. Returns the address to which external senders can send mail that this session can read via email_inbox.',
		inputSchema: { type: 'object', properties: {} },
	},
];

export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	env: ToolServerEnv,
	sessionId: string,
): Promise<string> {
	switch (name) {
		case 'email_send':
			return runEmailSend(args, env, sessionId);
		case 'email_inbox':
			return runEmailInbox(args, env, sessionId);
		case 'email_read':
			return runEmailRead(args, env, sessionId);
		case 'email_get_address':
			return runEmailGetAddress(env, sessionId);
		default:
			throw new Error(`email: unknown tool ${name}`);
	}
}

async function buildMimeMessage(opts: {
	from: string;
	to: string;
	subject: string;
	textBody: string;
	htmlBody?: string;
	messageId: string;
}): Promise<{ raw: string; from: string; to: string }> {
	const boundary = `cf-mail-${crypto.randomUUID()}`;
	const lines: string[] = [];
	lines.push(`From: ${opts.from}`);
	lines.push(`To: ${opts.to}`);
	lines.push(`Subject: ${opts.subject}`);
	lines.push(`Message-ID: <${opts.messageId}>`);
	lines.push('MIME-Version: 1.0');
	if (opts.htmlBody) {
		lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
		lines.push('');
		lines.push(`--${boundary}`);
		lines.push('Content-Type: text/plain; charset=utf-8');
		lines.push('Content-Transfer-Encoding: 7bit');
		lines.push('');
		lines.push(opts.textBody);
		lines.push('');
		lines.push(`--${boundary}`);
		lines.push('Content-Type: text/html; charset=utf-8');
		lines.push('Content-Transfer-Encoding: 7bit');
		lines.push('');
		lines.push(opts.htmlBody);
		lines.push(`--${boundary}--`);
	} else {
		lines.push('Content-Type: text/plain; charset=utf-8');
		lines.push('Content-Transfer-Encoding: 7bit');
		lines.push('');
		lines.push(opts.textBody);
	}
	return { raw: lines.join('\r\n'), from: opts.from, to: opts.to };
}

async function runEmailSend(args: Record<string, unknown>, env: ToolServerEnv, sessionId: string): Promise<string> {
	if (!env.SEND_EMAIL) throw new Error('SEND_EMAIL binding not configured');

	const to = str(args.to);
	const subject = str(args.subject);
	const body = str(args.body);
	if (!to) throw new Error('email_send requires to');
	if (!subject) throw new Error('email_send requires subject');
	if (!body) throw new Error('email_send requires body');

	const from = str(args.from || env.EMAIL_FROM || '');
	if (!from) throw new Error('email_send: no from address — pass `from` or set EMAIL_FROM');

	const domain = env.EMAIL_DOMAIN || 'cf-agents.local';
	const messageId = `${sessionId}.${crypto.randomUUID()}@${domain}`;

	const message = await buildMimeMessage({
		from,
		to,
		subject,
		textBody: body,
		messageId,
		...(args.html ? { htmlBody: str(args.html) } : {}),
	});

	const { EmailMessage } = (await import('cloudflare:email')) as {
		EmailMessage: new (from: string, to: string, raw: string) => unknown;
	};
	await env.SEND_EMAIL.send(new EmailMessage(message.from, message.to, message.raw));
	return `sent to ${to} (subject: ${subject.slice(0, 80)})`;
}

async function runEmailGetAddress(env: ToolServerEnv, sessionId: string): Promise<string> {
	if (!env.DB) throw new Error('DB binding not configured');

	const domain = env.EMAIL_DOMAIN ?? 'mail.gloriatrials.com';

	const existing = await env.DB
		.prepare('SELECT alias FROM agent_email_aliases WHERE session_id = ? LIMIT 1')
		.bind(sessionId)
		.first<{ alias: string }>();

	if (existing) {
		return JSON.stringify({ address: `${existing.alias}@${domain}` });
	}

	const alias = `agent-${sessionId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`;
	await env.DB
		.prepare('INSERT OR IGNORE INTO agent_email_aliases (alias, session_id, created_at_ms) VALUES (?, ?, ?)')
		.bind(alias, sessionId, Date.now())
		.run();

	return JSON.stringify({ address: `${alias}@${domain}` });
}

async function runEmailInbox(args: Record<string, unknown>, env: ToolServerEnv, _sessionId: string): Promise<string> {
	if (!env.DB) throw new Error('DB binding not configured');

	const limit = Math.min(Number(args.limit ?? 25), 50);
	const sinceMs = Number(args.since_ms ?? 0);

	const rows = await env.DB.prepare(
		`SELECT message_id, from_addr, to_addr, subject, received_at_ms, size_bytes, body_text
		 FROM agent_inbox
		 WHERE received_at_ms >= ?
		 ORDER BY received_at_ms DESC
		 LIMIT ?`,
	)
		.bind(sinceMs, limit)
		.all<{
			message_id: string;
			from_addr: string;
			to_addr: string;
			subject: string;
			received_at_ms: number;
			size_bytes: number;
			body_text: string | null;
		}>();

	const items = (rows.results ?? []).map((r) => ({
		id: r.message_id,
		from: r.from_addr,
		to: r.to_addr,
		subject: r.subject,
		receivedAt: new Date(r.received_at_ms).toISOString(),
		sizeBytes: r.size_bytes,
		body: r.body_text ? r.body_text.slice(0, 800) : null,
	}));

	if (items.length === 0) return '(empty inbox)';
	return JSON.stringify({ inbox: `agent@${env.EMAIL_DOMAIN ?? 'mail.gloriatrials.com'}`, items });
}

async function runEmailRead(args: Record<string, unknown>, env: ToolServerEnv, _sessionId: string): Promise<string> {
	if (!env.DB) throw new Error('DB binding not configured');

	const id = str(args.id);
	if (!id) throw new Error('email_read requires id');

	const row = await env.DB.prepare(
		`SELECT message_id, from_addr, to_addr, subject, received_at_ms, size_bytes, body_text
		 FROM agent_inbox
		 WHERE message_id = ?`,
	)
		.bind(id)
		.first<{
			message_id: string;
			from_addr: string;
			to_addr: string;
			subject: string;
			received_at_ms: number;
			size_bytes: number;
			body_text: string | null;
		}>();

	if (!row) throw new Error(`Message ${id} not found in this session's inbox`);

	return JSON.stringify({
		id: row.message_id,
		from: row.from_addr,
		to: row.to_addr,
		subject: row.subject,
		receivedAt: new Date(row.received_at_ms).toISOString(),
		sizeBytes: row.size_bytes,
		body: truncate(row.body_text ?? '(no body)'),
	});
}
