export interface McpRequest {
	jsonrpc: '2.0';
	id: number;
	method: string;
	params?: unknown;
}

export interface McpToolsCallParams {
	name: string;
	arguments: Record<string, unknown>;
}

export interface McpPropertySchema {
	type: string;
	description?: string;
	enum?: string[];
	additionalProperties?: McpPropertySchema | boolean;
	items?: McpPropertySchema;
	properties?: Record<string, McpPropertySchema>;
	required?: string[];
}

export interface McpToolInputSchema {
	type: 'object';
	properties: Record<string, McpPropertySchema>;
	required?: string[];
}

export interface McpTool {
	name: string;
	description: string;
	inputSchema: McpToolInputSchema;
}

export interface McpToolsListResult {
	tools: McpTool[];
}

export interface McpContent {
	type: 'text';
	text: string;
}

export interface McpToolsCallResult {
	content: McpContent[];
	isError?: boolean;
}

export interface McpInitializeResult {
	protocolVersion: string;
	capabilities: Record<string, unknown>;
	serverInfo: { name: string; version: string };
}

export interface McpResponse {
	jsonrpc: '2.0';
	id: number;
	result?: McpToolsListResult | McpToolsCallResult | McpInitializeResult;
	error?: { code: number; message: string; data?: unknown };
}
