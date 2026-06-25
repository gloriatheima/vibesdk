import type { McpTool } from '../../worker/agents/universal/mcp/types';
import type { ToolServerEnv } from '../env';
import { truncate, str } from '../utils';

export const TOOL_DEFINITIONS: McpTool[] = [
	{
		name: 'call_service',
		description:
			'Call a private internal service via a Cloudflare VPC service binding (Workers VPC + Tunnel). ' +
			'Only works when vpc_services bindings are declared in wrangler-tool-server.jsonc. ' +
			'Returns { status, body } as JSON.',
		inputSchema: {
			type: 'object',
			properties: {
				binding: { type: 'string', description: 'Name of the vpc_services binding. MUST be UPPERCASE (e.g. WORDPRESS, INTERNAL_API).' },
				path: { type: 'string', description: 'Request path, e.g. /v1/data' },
				method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'HTTP method (default GET)' },
				body: { type: 'string', description: 'Request body string for POST/PUT/PATCH. May also be passed as a JSON object — will be serialized automatically.' },
				headers: { type: 'string', description: 'Headers as a JSON-encoded string or plain object, e.g. {"Authorization":"Basic xxx","Content-Type":"application/json"}.' },
			},
			required: ['binding', 'path'],
		},
	},
];

export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	env: ToolServerEnv,
): Promise<string> {
	if (name !== 'call_service') throw new Error(`service: unknown tool ${name}`);

	const bindingName = str(args.binding).toUpperCase();
	const path = str(args.path || '/');
	const method = str(args.method || 'GET').toUpperCase();
	const rawBody = args.body;
	const body =
		rawBody === undefined
			? undefined
			: typeof rawBody === 'string'
				? rawBody
				: JSON.stringify(rawBody);

	if (!bindingName) throw new Error('call_service requires binding');

	const envRecord = env as unknown as Record<string, unknown>;
	const fetcher = envRecord[bindingName] as { fetch: (input: Request | string, init?: RequestInit) => Promise<Response> } | undefined;

	if (!fetcher || typeof fetcher.fetch !== 'function') {
		return `error: VPC binding "${bindingName}" is not configured. Add vpc_services entries to wrangler-tool-server.jsonc.`;
	}

	let extraHeaders: Record<string, string> = {};
	if (args.headers) {
		if (typeof args.headers === 'object' && args.headers !== null) {
			extraHeaders = args.headers as Record<string, string>;
		} else {
			try {
				extraHeaders = JSON.parse(str(args.headers)) as Record<string, string>;
			} catch {
				// ignore malformed headers
			}
		}
	}

	const url = new URL(path.startsWith('/') ? path : `/${path}`, 'http://service.local');
	const reqBody = method === 'GET' || method === 'HEAD' ? undefined : body;

	let resp = await fetcher.fetch(url.toString(), {
		method,
		headers: extraHeaders,
		body: reqBody,
		redirect: 'manual',
	} as RequestInit);

	// Follow redirects manually to preserve method and body (prevents POST→GET on 301/302)
	let redirects = 0;
	while (resp.status >= 301 && resp.status <= 308 && redirects < 5) {
		const location = resp.headers.get('Location');
		if (!location) break;
		const redirectUrl = new URL(location, url.toString());
		const isInternal = redirectUrl.hostname === 'service.local';
		if (isInternal) {
			resp = await fetcher.fetch(redirectUrl.toString(), {
				method,
				headers: extraHeaders,
				body: reqBody,
				redirect: 'manual',
			} as RequestInit);
		} else {
			resp = await fetch(redirectUrl.toString(), {
				method,
				headers: { ...extraHeaders },
				body: reqBody,
				redirect: 'manual',
			});
		}
		redirects++;
	}

	let text = await resp.text();

	const hostHeader = extraHeaders['Host'] || extraHeaders['host'];
	if (hostHeader && text.includes('service.local')) {
		text = text.replaceAll(`https://service.local`, `https://${hostHeader}`);
		text = text.replaceAll(`http://service.local`, `https://${hostHeader}`);
		text = text.replaceAll('service.local', hostHeader);
	}

	// If body is valid JSON, embed it directly to avoid double-encoding.
	// This lets the LLM read all fields (unicode titles, URLs) without escaping.
	let parsedBody: unknown;
	try {
		parsedBody = JSON.parse(text);
	} catch {
		// Not JSON — normalize escaped slashes and embed as string
		text = text.replaceAll('\\/', '/');
		parsedBody = truncate(text);
	}

	return truncate(JSON.stringify({ status: resp.status, body: parsedBody }));
}
