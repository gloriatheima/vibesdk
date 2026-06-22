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
	{
		name: 'worker_deploy',
		description:
			'Deploy a Cloudflare Worker script to the platform dispatch namespace. ' +
			'Returns { name, url } where url is the permanent public HTTPS URL. ' +
			'Use for: backend REST APIs, full-stack apps (Hono API + embedded frontend build), WebSocket servers, or any service that must stay running and be publicly accessible. ' +
			'The script MUST be a valid ES module with `export default { async fetch(request, env, ctx) {} }`. ' +
			'Once deployed the worker is immediately live at the returned URL.',
		inputSchema: {
			type: 'object',
			properties: {
				name: {
					type: 'string',
					description: 'Unique worker name, lowercase letters/numbers/hyphens only. Becomes the subdomain: https://{name}.vibesdk.gloriatrials.com',
				},
				script: {
					type: 'string',
					description: 'Complete ES module Worker script. Must export default with a fetch handler.',
				},
			},
			required: ['name', 'script'],
		},
	},
];

export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	env: ToolServerEnv,
): Promise<string> {
	if (name === 'worker_deploy') return runWorkerDeploy(args, env);
	if (name === 'call_worker') return runCallWorker(args, env);
	throw new Error(`dispatch: unknown tool ${name}`);
}

async function runCallWorker(args: Record<string, unknown>, env: ToolServerEnv): Promise<string> {
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

	return JSON.stringify({ status: resp.status, body: truncate(text) });
}

async function ensureWildcardDns(domain: string, apiToken: string): Promise<void> {
	const apex = domain.split('.').slice(-2).join('.');
	const zonesResp = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${apex}`, {
		headers: { Authorization: `Bearer ${apiToken}` },
	});
	if (!zonesResp.ok) return;
	const zones = (await zonesResp.json()) as { result?: Array<{ id: string }> };
	const zoneId = zones.result?.[0]?.id;
	if (!zoneId) return;

	// Create wildcard CNAME; silently ignore errors (e.g. record already exists)
	await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
		body: JSON.stringify({ type: 'CNAME', name: `*.${domain}`, content: domain, proxied: true, ttl: 1 }),
	});
}

async function runWorkerDeploy(args: Record<string, unknown>, env: ToolServerEnv): Promise<string> {
	const workerName = str(args.name).toLowerCase().replace(/[^a-z0-9-]/g, '-');
	const script = str(args.script);

	if (!workerName) throw new Error('worker_deploy requires name');
	if (!script) throw new Error('worker_deploy requires script');
	if (!env.CLOUDFLARE_ACCOUNT_ID) throw new Error('CLOUDFLARE_ACCOUNT_ID not configured');
	if (!env.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN not configured');

	const namespace = env.DISPATCH_NAMESPACE ?? 'vibesdk-default-namespace';
	const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/dispatch/namespaces/${namespace}/scripts/${workerName}`;

	const metadata = JSON.stringify({
		main_module: 'index.js',
		compatibility_date: '2025-01-01',
		compatibility_flags: ['nodejs_compat'],
	});

	const formData = new FormData();
	formData.append('metadata', new Blob([metadata], { type: 'application/json' }), 'metadata.json');
	formData.append('index.js', new Blob([script], { type: 'application/javascript+module' }), 'index.js');

	const resp = await fetch(apiUrl, {
		method: 'PUT',
		headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
		body: formData,
	});

	if (!resp.ok) {
		const errText = await resp.text();
		throw new Error(`worker_deploy failed (${resp.status}): ${truncate(errText)}`);
	}

	const domain = env.CUSTOM_DOMAIN ?? 'vibesdk.gloriatrials.com';
	const url = `https://${workerName}.${domain}`;

	// Best-effort: ensure wildcard DNS CNAME exists so subdomains resolve immediately
	await ensureWildcardDns(domain, env.CLOUDFLARE_API_TOKEN).catch(() => {});

	return JSON.stringify({ name: workerName, url, status: 'deployed' });
}
