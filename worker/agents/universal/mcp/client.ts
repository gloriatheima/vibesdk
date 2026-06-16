import { createLogger } from '../../../logger';
import type { ActionEventData, ToolResultEventData } from '../types';
import type { McpRequest, McpResponse, McpToolsCallResult } from './types';

const logger = createLogger('MCPClient');

type ServiceRoute = { kind: 'service'; fetcher: Fetcher };
type HttpRoute = { kind: 'http'; url: string; headers?: Record<string, string> };
type LocalRoute = { kind: 'local'; handler: LocalHandler };

type ToolRoute = ServiceRoute | HttpRoute | LocalRoute;

type LocalHandler = (action: ActionEventData) => Promise<string>;

export class MCPClient {
	private routes = new Map<string, ToolRoute>();
	private sessionId: string;
	private requestId = 0;

	constructor(sessionId: string) {
		this.sessionId = sessionId;
	}

	registerServiceBinding(toolNames: string[], fetcher: Fetcher): void {
		for (const name of toolNames) {
			this.routes.set(name, { kind: 'service', fetcher });
		}
	}

	registerHttpServer(toolNames: string[], url: string, headers?: Record<string, string>): void {
		for (const name of toolNames) {
			this.routes.set(name, { kind: 'http', url, headers });
		}
	}

	registerLocal(toolNames: string[], handler: LocalHandler): void {
		for (const name of toolNames) {
			this.routes.set(name, { kind: 'local', handler });
		}
	}

	async run(action: ActionEventData): Promise<ToolResultEventData> {
		try {
			const output = await this.callTool(action);
			logger.info('Tool executed', { tool: action.tool, step: action.step });
			return { step: action.step, tool: action.tool, success: true, output };
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.warn('Tool failed', { tool: action.tool, step: action.step, error: msg });
			return { step: action.step, tool: action.tool, success: false, output: '', error: msg };
		}
	}

	private async callTool(action: ActionEventData): Promise<string> {
		const route = this.routes.get(action.tool);

		if (!route) {
			throw new Error(`No route registered for tool: ${action.tool}`);
		}

		if (route.kind === 'local') {
			return route.handler(action);
		}

		const id = ++this.requestId;
		const body: McpRequest = {
			jsonrpc: '2.0',
			id,
			method: 'tools/call',
			params: { name: action.tool, arguments: action.params },
		};

		const headers: Record<string, string> = {
			'content-type': 'application/json',
			'x-session-id': this.sessionId,
		};

		if (route.kind === 'http' && route.headers) {
			Object.assign(headers, route.headers);
		}

		const req = new Request('https://tool-server.internal/', {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		});

		const resp =
			route.kind === 'service'
				? await route.fetcher.fetch(req)
				: await fetch(route.url, { method: 'POST', headers, body: JSON.stringify(body) });

		if (!resp.ok) {
			const text = await resp.text().catch(() => resp.statusText);
			throw new Error(`MCP server ${resp.status}: ${text.slice(0, 200)}`);
		}

		const json = (await resp.json()) as McpResponse;

		if (json.error) {
			throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
		}

		const result = json.result as McpToolsCallResult;
		if (!result?.content) {
			throw new Error('MCP response missing content');
		}

		if (result.isError) {
			throw new Error(result.content.map((c) => c.text).join(''));
		}

		return result.content.map((c) => c.text ?? '').join('');
	}
}
