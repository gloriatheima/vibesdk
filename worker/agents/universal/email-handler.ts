// Inbound email handler for the Universal Agent.
//
// Cloudflare Email Routing calls the Worker's `email()` export when a
// routed message arrives. We extract sender, subject, and body then
// write it to the `agent_inbox` D1 table keyed by session_id.
//
// Routing: the local-part of the `To:` address is used as an alias to
// look up the owning session in `agent_email_aliases`. If no alias row
// is found the message is rejected.
//
// Dashboard setup (one-time):
//   Email Routing → Routes → add Catch-all `*@mail.gloriatrials.com`
//   → "Send to a Worker" → this worker.

const MAX_RAW_BYTES = 256_000;

export interface ForwardableEmailMessage {
	readonly from: string;
	readonly to: string;
	readonly raw: ReadableStream<Uint8Array>;
	readonly rawSize: number;
	readonly headers: Headers;
	setReject(reason: string): void;
	forward(rcptTo: string, headers?: Headers): Promise<void>;
}

async function readStream(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (total + value.length > max) {
			chunks.push(value.slice(0, max - total));
			truncated = true;
			break;
		}
		chunks.push(value);
		total += value.length;
	}
	reader.releaseLock();
	const combined = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
	let offset = 0;
	for (const c of chunks) {
		combined.set(c, offset);
		offset += c.length;
	}
	if (truncated) {
		const marker = new TextEncoder().encode('\n[truncated]');
		const out = new Uint8Array(combined.length + marker.length);
		out.set(combined);
		out.set(marker, combined.length);
		return out;
	}
	return combined;
}

function extractAlias(toAddr: string): string {
	const local = toAddr.split('@')[0] ?? '';
	return local.replace(/\+.*$/, '').toLowerCase();
}

function extractBodyText(raw: string): string | null {
	const textMatch = raw.match(/Content-Type:\s*text\/plain[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*?)(?=\r?\n--|\r?\n\r?\n--|\s*$)/i);
	if (textMatch) return textMatch[1].trim() || null;
	const bodyStart = raw.indexOf('\r\n\r\n');
	if (bodyStart !== -1) {
		const body = raw.slice(bodyStart + 4).split(/\r?\n--/)[0];
		return body.trim() || null;
	}
	return null;
}

export async function handleInboundEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
	const db = env.DB;
	if (!db) {
		message.setReject('DB binding not configured');
		return;
	}

	const alias = extractAlias(message.to);
	if (!alias) {
		message.setReject('Cannot parse alias from recipient address');
		return;
	}

	const aliasRow = await db
		.prepare('SELECT session_id FROM agent_email_aliases WHERE alias = ?')
		.bind(alias)
		.first<{ session_id: string }>();

	if (!aliasRow) {
		message.setReject(`No session mapped to alias: ${alias}`);
		return;
	}

	const subject = message.headers.get('subject') ?? '(no subject)';
	const rawBytes = await readStream(message.raw, MAX_RAW_BYTES);
	const rawText = new TextDecoder().decode(rawBytes);
	const bodyText = extractBodyText(rawText);
	const messageId = message.headers.get('message-id') ?? `${Date.now()}.${crypto.randomUUID()}`;

	await db
		.prepare(
			`INSERT OR IGNORE INTO agent_inbox
			 (message_id, session_id, from_addr, to_addr, subject, received_at_ms, size_bytes, body_text)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			messageId,
			aliasRow.session_id,
			message.from,
			message.to,
			subject,
			Date.now(),
			message.rawSize,
			bodyText,
		)
		.run();
}
