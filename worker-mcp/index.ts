import { getSandbox } from '@cloudflare/sandbox';
import type { Sandbox as SandboxDO } from '@cloudflare/sandbox';
import type { ToolServerEnv } from './env';
import { handleMcpRequest } from './router';
import type { SandboxPool as SandboxPoolType } from './pool';

export { Sandbox } from '@cloudflare/sandbox';
export { SandboxPool } from './pool';
export { PersistentSandbox } from './persistent-sandbox';

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

	async scheduled(_controller: ScheduledController, env: ToolServerEnv): Promise<void> {
		const pool = env.SandboxPool.get(
			env.SandboxPool.idFromName('global'),
		) as unknown as SandboxPoolType;
		const slotIds = await pool.getAllSlotIds();
		const ps = env.PersistentSandbox as unknown as DurableObjectNamespace<SandboxDO>;
		await Promise.allSettled(
			slotIds.map((id) => {
				const sandbox = getSandbox(ps, id);
				return sandbox.exec('echo "keepalive"', { timeout: 30 });
			}),
		);
	},
} satisfies ExportedHandler<ToolServerEnv>;
