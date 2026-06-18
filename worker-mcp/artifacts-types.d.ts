// Minimal type declarations for Cloudflare Artifacts binding (closed beta).
// Replace with generated types once `wrangler types` includes Artifacts.

interface ArtifactsCreateRepoResult {
	name: string;
	remote: string;
	defaultBranch: string;
	token: string;
}

interface ArtifactsRepo {
	name: string;
	remote: string;
	defaultBranch: string;
	createToken(scope?: 'read' | 'write', ttl?: number): Promise<ArtifactsCreateTokenResult>;
	listTokens(): Promise<ArtifactsTokenListResult>;
	revokeToken(tokenOrId: string): Promise<boolean>;
}

interface ArtifactsCreateTokenResult {
	plaintext: string;
	expiresAt: string;
}

interface ArtifactsTokenListResult {
	total: number;
	tokens: ArtifactsTokenInfo[];
}

interface ArtifactsTokenInfo {
	id: string;
	scope: 'read' | 'write';
	expiresAt: string;
}

interface ArtifactsRepoInfo {
	name: string;
	status: 'ready' | 'importing' | 'forking';
}

interface ArtifactsRepoListResult {
	repos: ArtifactsRepoInfo[];
	cursor?: string;
}

interface ArtifactsImportParams {
	source: {
		url: string;
		branch?: string;
		depth?: number;
	};
	target: {
		name: string;
		opts?: {
			description?: string;
			readOnly?: boolean;
		};
	};
}

interface ArtifactsCreateOpts {
	description?: string;
	readOnly?: boolean;
	setDefaultBranch?: string;
}

declare class Artifacts {
	create(name: string, opts?: ArtifactsCreateOpts): Promise<ArtifactsCreateRepoResult>;
	get(name: string): Promise<ArtifactsRepo>;
	list(opts?: { limit?: number; cursor?: string }): Promise<ArtifactsRepoListResult>;
	delete(name: string): Promise<boolean>;
	import(params: ArtifactsImportParams): Promise<ArtifactsCreateRepoResult>;
}
