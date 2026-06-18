import { getSandbox } from '@cloudflare/sandbox';
import type { McpTool } from '../../worker/agents/universal/mcp/types';
import type { ToolServerEnv } from '../env';
import { str, truncate } from '../utils';

export const TOOL_DEFINITIONS: McpTool[] = [
	{
		name: 'sandbox_run',
		description:
			'Execute a shell command in the agent sandbox container (Ubuntu 22.04, Node 20, Python 3.11, git). ' +
			'The sandbox is persistent per session — filesystem changes and env vars survive across calls. ' +
			'Use envVars to inject secrets (e.g. ARTIFACTS_GIT_REMOTE for git push). ' +
			'Returns { stdout, stderr, exitCode, success }.',
		inputSchema: {
			type: 'object',
			properties: {
				command: {
					type: 'string',
					description: 'Shell command to execute (bash -c "..."). May span multiple lines.',
				},
				envVars: {
					type: 'object',
					description:
						'Key-value env vars to set in the sandbox before running the command. ' +
						'These persist for all subsequent sandbox_run calls in the same session. ' +
						'Example: { "ARTIFACTS_GIT_REMOTE": "https://x:token@repo.artifacts.cfdata.org/..." }',
					additionalProperties: { type: 'string' },
				},
				timeout: {
					type: 'number',
					description: 'Max seconds to wait for the command (default: 120)',
				},
			},
			required: ['command'],
		},
	},
	{
		name: 'sandbox_write',
		description:
			'Write a file directly to the sandbox container filesystem. ' +
			'Prefer this over echo/heredoc in sandbox_run for large or binary-unsafe content. ' +
			'Parent directories are created automatically.',
		inputSchema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Absolute path in the container (e.g. "/workspace/src/index.ts")',
				},
				content: {
					type: 'string',
					description: 'File content as a UTF-8 string',
				},
			},
			required: ['path', 'content'],
		},
	},
	{
		name: 'sandbox_read',
		description: 'Read a file from the sandbox container filesystem.',
		inputSchema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Absolute path in the container',
				},
			},
			required: ['path'],
		},
	},
];

export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	env: ToolServerEnv,
	sessionId: string,
): Promise<string> {
	if (!env.Sandbox) throw new Error('Sandbox binding not configured on tool server');

	const sandbox = getSandbox(env.Sandbox, sessionId);

	switch (name) {
		case 'sandbox_run':
			return runExec(args, sandbox);
		case 'sandbox_write':
			return runWrite(args, sandbox);
		case 'sandbox_read':
			return runRead(args, sandbox);
		default:
			throw new Error(`sandbox: unknown tool ${name}`);
	}
}

type SandboxInstance = ReturnType<typeof getSandbox>;

async function runExec(args: Record<string, unknown>, sandbox: SandboxInstance): Promise<string> {
	const command = str(args.command);
	if (!command) throw new Error('sandbox_run requires command');

	const timeout = typeof args.timeout === 'number' ? args.timeout : 120;

	if (args.envVars !== undefined && args.envVars !== null) {
		if (typeof args.envVars !== 'object' || Array.isArray(args.envVars)) {
			throw new Error('sandbox_run: envVars must be an object of string key-value pairs');
		}
		await sandbox.setEnvVars(args.envVars as Record<string, string>);
	}

	const result = await sandbox.exec(command, { timeout });

	return JSON.stringify({
		stdout: truncate(result.stdout, 10_000),
		stderr: truncate(result.stderr, 5_000),
		exitCode: result.exitCode,
		success: result.success,
	});
}

async function runWrite(args: Record<string, unknown>, sandbox: SandboxInstance): Promise<string> {
	const path = str(args.path);
	const content = str(args.content);
	if (!path) throw new Error('sandbox_write requires path');

	const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
	if (dir) {
		await sandbox.exec(`mkdir -p "${dir}"`, { timeout: 10 });
	}

	await sandbox.writeFile(path, content);

	return JSON.stringify({ path, bytes: new TextEncoder().encode(content).length });
}

async function runRead(args: Record<string, unknown>, sandbox: SandboxInstance): Promise<string> {
	const path = str(args.path);
	if (!path) throw new Error('sandbox_read requires path');

	const file = await sandbox.readFile(path);

	return JSON.stringify({ path, content: truncate(file.content, 50_000) });
}
