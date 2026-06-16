import type { McpTool } from '../../worker/agents/universal/mcp/types';
import type { ToolServerEnv } from '../env';
import { truncate, str } from '../utils';

export const TOOL_DEFINITIONS: McpTool[] = [
	{
		name: 'call_worker',
		description:
			'Call a Worker deployed in the platform dispatch namespace (Workers for Platforms). ' +
			'Returns { status, body } as JSON.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Worker name in the dispatch namespace' },
				path: { type: 'string', description: 'Request path, e.g. /api/data' },
				method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'HTTP method (default GET)' },
				body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
				headers: { type: 'string', description: 'JSON-encoded headers object (optional)' },
			},
			required: ['name', 'path'],
		},
	},
];

export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	env: ToolServerEnv,
): Promise<string> {
	if (name !== 'call_worker') throw new Error(`dispatch: unknown tool ${name}`);

	const workerName = str(args.name);
	const path = str(args.path || '/');
	const method = str(args.method || 'GET').toUpperCase();
	const body = args.body !== undefined ? str(args.body) : undefined;

	if (!workerName) throw new Error('call_worker requires name');

	if (!env.DISPATCHER) throw new Error('DISPATCHER binding not configured');

	let extraHeaders: Record<string, string> = {};
	if (args.headers) {
		try {
			extraHeaders = JSON.parse(str(args.headers)) as Record<string, string>;
		} catch {
			// ignore malformed headers
		}
	}

	const url = new URL(path.startsWith('/') ? path : `/${path}`, 'https://worker.internal');
	const req = new Request(url.toString(), {
		method,
		headers: { 'content-type': 'application/json', ...extraHeaders },
		body: method === 'GET' || method === 'HEAD' ? undefined : body,
	});

	const worker = env.DISPATCHER.get(workerName);
	const resp = await worker.fetch(req);
	const text = await resp.text();

	return JSON.stringify({
		status: resp.status,
		body: truncate(text),
	});
}
