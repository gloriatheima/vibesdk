import type { McpTool } from '../../worker/agents/universal/mcp/types';
import type { ToolServerEnv } from '../env';
import { truncate, str } from '../utils';

export const TOOL_DEFINITIONS: McpTool[] = [
	{
		name: 'http_fetch',
		description: 'Fetch any URL and return the raw HTTP response body.',
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'URL to fetch' },
				method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'HTTP method (default GET)' },
				body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
			},
			required: ['url'],
		},
	},
];

export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	_env: ToolServerEnv,
): Promise<string> {
	if (name !== 'http_fetch') throw new Error(`http: unknown tool ${name}`);

	const url = str(args.url);
	const method = str(args.method || 'GET').toUpperCase();
	const body = args.body !== undefined ? str(args.body) : undefined;
	if (!url) throw new Error('http_fetch requires url');

	const resp = await fetch(url, { method, body });
	const text = await resp.text();
	return `HTTP ${resp.status}\n${truncate(text, 3000)}`;
}
