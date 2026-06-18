import type { McpTool } from '../../worker/agents/universal/mcp/types';
import type { ToolServerEnv } from '../env';
import { str } from '../utils';

export const TOOL_DEFINITIONS: McpTool[] = [
	{
		name: 'artifact_create',
		description:
			'Create a new Artifacts git repo (or retrieve an existing one by name). ' +
			'Returns the git remote URL, a write token for sandbox git push, and a read token for user git clone.',
		inputSchema: {
			type: 'object',
			properties: {
				name: {
					type: 'string',
					description: 'Repo name (alphanumeric and hyphens only, e.g. "slides-abc123")',
				},
				description: {
					type: 'string',
					description: 'Optional description for the repo',
				},
			},
			required: ['name'],
		},
	},
	{
		name: 'artifact_get_token',
		description:
			'Mint a new access token for an existing Artifacts repo. ' +
			'Use scope="write" to get a token for git push inside a sandbox, scope="read" for user git clone.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Repo name' },
				scope: {
					type: 'string',
					enum: ['read', 'write'],
					description: 'Token scope: "read" (clone/fetch) or "write" (push). Default: read',
				},
				ttl: {
					type: 'number',
					description: 'Token lifetime in seconds (default: 86400 = 24h)',
				},
			},
			required: ['name'],
		},
	},
	{
		name: 'artifact_list',
		description: 'List all Artifacts repos in the namespace.',
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'number', description: 'Max number of repos to return (default: 20)' },
			},
		},
	},
	{
		name: 'artifact_delete',
		description: 'Permanently delete an Artifacts repo and all its history.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Repo name to delete' },
			},
			required: ['name'],
		},
	},
];

export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	env: ToolServerEnv,
): Promise<string> {
	if (!env.ARTIFACTS) throw new Error('ARTIFACTS binding not configured on tool server');
	const artifacts = env.ARTIFACTS;

	switch (name) {
		case 'artifact_create':
			return runCreate(args, artifacts);
		case 'artifact_get_token':
			return runGetToken(args, artifacts);
		case 'artifact_list':
			return runList(args, artifacts);
		case 'artifact_delete':
			return runDelete(args, artifacts);
		default:
			throw new Error(`artifacts: unknown tool ${name}`);
	}
}

function toAuthRemote(remote: string, token: string): string {
	const secret = token.split('?expires=')[0];
	return `https://x:${secret}@${remote.slice('https://'.length)}`;
}

async function runCreate(args: Record<string, unknown>, artifacts: Artifacts): Promise<string> {
	const repoName = str(args.name);
	if (!repoName) throw new Error('artifact_create requires name');

	const description = args.description ? str(args.description) : undefined;

	let remote: string;
	let writeToken: string;
	let defaultBranch: string;

	try {
		const created = await artifacts.create(repoName, {
			description,
			readOnly: false,
			setDefaultBranch: 'main',
		});
		remote = created.remote;
		writeToken = created.token;
		defaultBranch = created.defaultBranch;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes('already exists') || msg.includes('conflict')) {
			const repo = await artifacts.get(repoName);
			remote = repo.remote;
			defaultBranch = repo.defaultBranch;
			const tokenResult = await repo.createToken('write', 3600);
			writeToken = tokenResult.plaintext;
		} else {
			throw err;
		}
	}

	const repo = await artifacts.get(repoName);
	const readTokenResult = await repo.createToken('read', 86400 * 7);

	return JSON.stringify({
		name: repoName,
		remote,
		defaultBranch,
		writeToken,
		authRemote: toAuthRemote(remote, writeToken),
		readToken: readTokenResult.plaintext,
		readTokenExpiresAt: readTokenResult.expiresAt,
	});
}

async function runGetToken(args: Record<string, unknown>, artifacts: Artifacts): Promise<string> {
	const repoName = str(args.name);
	if (!repoName) throw new Error('artifact_get_token requires name');

	const scope = args.scope === 'write' ? 'write' : ('read' as const);
	const ttl = typeof args.ttl === 'number' ? args.ttl : 86400;

	const repo = await artifacts.get(repoName);
	const tokenResult = await repo.createToken(scope, ttl);

	return JSON.stringify({
		name: repoName,
		remote: repo.remote,
		scope,
		token: tokenResult.plaintext,
		authRemote: scope === 'write' ? toAuthRemote(repo.remote, tokenResult.plaintext) : undefined,
		expiresAt: tokenResult.expiresAt,
	});
}

async function runList(args: Record<string, unknown>, artifacts: Artifacts): Promise<string> {
	const limit = typeof args.limit === 'number' ? args.limit : 20;
	const result = await artifacts.list({ limit });

	return JSON.stringify({
		repos: result.repos.map((r) => ({ name: r.name, status: r.status })),
		cursor: result.cursor ?? null,
	});
}

async function runDelete(args: Record<string, unknown>, artifacts: Artifacts): Promise<string> {
	const repoName = str(args.name);
	if (!repoName) throw new Error('artifact_delete requires name');

	const deleted = await artifacts.delete(repoName);
	return JSON.stringify({ deleted, name: repoName });
}
