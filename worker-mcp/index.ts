import type { ToolServerEnv } from './env';
import { handleMcpRequest } from './router';

export { Sandbox } from '@cloudflare/sandbox';

export default {
	async fetch(request: Request, env: ToolServerEnv): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				headers: {
					'access-control-allow-origin': '*',
					'access-control-allow-methods': 'POST, OPTIONS',
					'access-control-allow-headers': 'content-type, x-session-id',
				},
			});
		}

		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', { status: 405 });
		}

		return handleMcpRequest(request, env);
	},
} satisfies ExportedHandler<ToolServerEnv>;
