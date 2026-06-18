import type { Sandbox as SandboxDO } from '@cloudflare/sandbox';

export interface ToolServerEnv {
	DB: D1Database;
	BROWSER: Fetcher;
	SEND_EMAIL: { send(message: unknown): Promise<void> };
	DISPATCHER: DispatchNamespace;
	WORDPRESS: Fetcher;
	ARTIFACTS?: Artifacts;
	Sandbox: DurableObjectNamespace<SandboxDO>;
	CLOUDFLARE_ACCOUNT_ID: string;
	CLOUDFLARE_API_TOKEN: string;
	EMAIL_FROM: string;
	EMAIL_DOMAIN: string;
}
