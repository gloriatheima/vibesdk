import type { McpRequest, McpResponse, McpToolsCallParams, McpTool } from '../worker/agents/universal/mcp/types';
import type { ToolServerEnv } from './env';
import * as browser from './tools/browser';
import * as email from './tools/email';
import * as http from './tools/http';
import * as dispatch from './tools/dispatch';
import * as service from './tools/service';
import * as artifacts from './tools/artifacts';
import * as sandbox from './tools/sandbox';

const ALL_TOOL_DEFINITIONS: McpTool[] = [
	...browser.TOOL_DEFINITIONS,
	...email.TOOL_DEFINITIONS,
	...http.TOOL_DEFINITIONS,
	...dispatch.TOOL_DEFINITIONS,
	...service.TOOL_DEFINITIONS,
	...artifacts.TOOL_DEFINITIONS,
	...sandbox.TOOL_DEFINITIONS,
];

type ToolModule = {
	executeTool: (name: string, args: Record<string, unknown>, env: ToolServerEnv, sessionId: string) => Promise<string>;
};

const TOOL_MODULE_MAP: Record<string, ToolModule> = {};
for (const def of browser.TOOL_DEFINITIONS) TOOL_MODULE_MAP[def.name] = browser;
for (const def of email.TOOL_DEFINITIONS) TOOL_MODULE_MAP[def.name] = email;
for (const def of http.TOOL_DEFINITIONS) TOOL_MODULE_MAP[def.name] = http;
for (const def of dispatch.TOOL_DEFINITIONS) TOOL_MODULE_MAP[def.name] = dispatch;
for (const def of service.TOOL_DEFINITIONS) TOOL_MODULE_MAP[def.name] = service;
for (const def of artifacts.TOOL_DEFINITIONS) TOOL_MODULE_MAP[def.name] = artifacts;
for (const def of sandbox.TOOL_DEFINITIONS) TOOL_MODULE_MAP[def.name] = sandbox;

function ok(id: number, result: unknown): McpResponse {
	return { jsonrpc: '2.0', id, result: result as McpResponse['result'] };
}

function err(id: number, code: number, message: string): McpResponse {
	return { jsonrpc: '2.0', id, error: { code, message } };
}

export async function handleMcpRequest(request: Request, env: ToolServerEnv): Promise<Response> {
	const sessionId = request.headers.get('x-session-id') ?? '';

	let body: McpRequest;
	try {
		body = (await request.json()) as McpRequest;
	} catch {
		return jsonResponse(err(0, -32700, 'Parse error'));
	}

	const { id, method } = body;

	if (method === 'initialize') {
		return jsonResponse(
			ok(id, {
				protocolVersion: '2024-11-05',
				capabilities: { tools: {} },
				serverInfo: { name: 'vibesdk-tool-server', version: '1.0.0' },
			}),
		);
	}

	if (method === 'tools/list') {
		return jsonResponse(ok(id, { tools: ALL_TOOL_DEFINITIONS }));
	}

	if (method === 'tools/call') {
		const params = body.params as McpToolsCallParams | undefined;
		if (!params?.name) {
			return jsonResponse(err(id, -32602, 'Missing tool name'));
		}

		const module = TOOL_MODULE_MAP[params.name];
		if (!module) {
			return jsonResponse(err(id, -32601, `Unknown tool: ${params.name}`));
		}

		try {
			const output = await module.executeTool(params.name, params.arguments ?? {}, env, sessionId);
			return jsonResponse(ok(id, { content: [{ type: 'text', text: output }] }));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return jsonResponse(ok(id, { content: [{ type: 'text', text: message }], isError: true }));
		}
	}

	return jsonResponse(err(id ?? 0, -32601, `Method not found: ${method}`));
}

function jsonResponse(body: McpResponse): Response {
	return new Response(JSON.stringify(body), {
		headers: { 'content-type': 'application/json' },
	});
}
