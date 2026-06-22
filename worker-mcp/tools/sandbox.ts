import { getSandbox } from '@cloudflare/sandbox';
import type { Sandbox as SandboxDO } from '@cloudflare/sandbox';
import type { McpTool } from '../../worker/agents/universal/mcp/types';
import type { ToolServerEnv } from '../env';
import type { SandboxPool } from '../pool';
import { str, truncate } from '../utils';

export const TOOL_DEFINITIONS: McpTool[] = [
	{
		name: 'shell_exec',
		description:
			'Execute a one-shot shell command in the agent sandbox container (Ubuntu 22.04, Node 20, Python 3.11, git). ' +
			'Use for quick commands where session persistence is not required. ' +
			'Returns { stdout, stderr, exitCode, success }.',
		inputSchema: {
			type: 'object',
			properties: {
				command: {
					type: 'string',
					description: 'Shell command to execute.',
				},
				timeout: {
					type: 'number',
					description: 'Max seconds to wait for the command (default: 60)',
				},
			},
			required: ['command'],
		},
	},
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

async function acquirePoolSlot(env: ToolServerEnv, sessionId: string): Promise<string> {
	try {
		const pool = env.SandboxPool.get(
			env.SandboxPool.idFromName('global'),
		) as unknown as SandboxPool;
		const result = await pool.acquire(sessionId);
		if (!result) return sessionId;
		if (result.needsCleanup) {
			const ps = env.PersistentSandbox as unknown as DurableObjectNamespace<SandboxDO>;
			const sandbox = getSandbox(ps, result.slotId);
			await sandbox
				.exec('rm -rf /workspace && mkdir -p /workspace', { timeout: 15 })
				.catch(() => {});
		}
		return result.slotId;
	} catch {
		return sessionId;
	}
}

export async function warmupSandbox(env: ToolServerEnv, sessionId: string): Promise<void> {
	if (!env.Sandbox) return;
	try {
		const sandboxId = await acquirePoolSlot(env, sessionId);
		const isPoolSlot = sandboxId.startsWith('sandbox-pool-');
		const ns = isPoolSlot
			? (env.PersistentSandbox as unknown as DurableObjectNamespace<SandboxDO>)
			: env.Sandbox;
		const sandbox = getSandbox(ns, sandboxId);
		await withContainerRetry(() => sandbox.exec('echo warmup', { timeout: 10 }));
	} catch {
		// non-fatal — warmup failure is silent; the real call will handle it
	}
}

export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	env: ToolServerEnv,
	sessionId: string,
): Promise<string> {
	if (!env.Sandbox) throw new Error('Sandbox binding not configured on tool server');

	const sandboxId = await acquirePoolSlot(env, sessionId);
	const isPoolSlot = sandboxId.startsWith('sandbox-pool-');
	const ns = isPoolSlot
		? (env.PersistentSandbox as unknown as DurableObjectNamespace<SandboxDO>)
		: env.Sandbox;
	const sandbox = getSandbox(ns, sandboxId);

	switch (name) {
		case 'shell_exec':
			return runExec({ timeout: 60, ...args }, sandbox);
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

const CONTAINER_ERROR_PATTERNS = ['Unknown Error', 'container not ready', 'provisioning'];
const RETRY_DELAYS_MS = [8_000, 15_000, 25_000];

function isContainerError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return CONTAINER_ERROR_PATTERNS.some(p => err.message.includes(p));
}

async function withContainerRetry<T>(fn: () => Promise<T>): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (isContainerError(err) && attempt < RETRY_DELAYS_MS.length) {
				await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
				continue;
			}
			throw err;
		}
	}
	throw lastErr;
}

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

	const result = await withContainerRetry(() => sandbox.exec(command, { timeout }));

	return JSON.stringify({
		stdout: truncate(result.stdout, 10_000),
		stderr: truncate(result.stderr, 5_000),
		exitCode: result.exitCode,
		success: result.success,
	});
}

async function runWrite(args: Record<string, unknown>, sandbox: SandboxInstance): Promise<string> {
	let path = str(args.path ?? args.filename);
	const content = str(args.content);
	if (!path) throw new Error('sandbox_write requires path');
	if (!path.startsWith('/')) path = `/workspace/${path}`;

	const dir = path.slice(0, path.lastIndexOf('/'));
	if (dir && dir !== '/workspace') {
		await withContainerRetry(() => sandbox.exec(`mkdir -p "${dir}"`, { timeout: 30 }));
	}

	await withContainerRetry(() => sandbox.writeFile(path, content));

	return JSON.stringify({ path, bytes: new TextEncoder().encode(content).length });
}

async function runRead(args: Record<string, unknown>, sandbox: SandboxInstance): Promise<string> {
	const path = str(args.path);
	if (!path) throw new Error('sandbox_read requires path');

	const file = await withContainerRetry(() => sandbox.readFile(path));

	return JSON.stringify({ path, content: truncate(file.content, 50_000) });
}
