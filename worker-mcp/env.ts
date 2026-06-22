import type { Sandbox as SandboxDO } from '@cloudflare/sandbox';
import type { SandboxPool } from './pool';
import type { PersistentSandbox } from './persistent-sandbox';

export interface ToolServerEnv {
	DB: D1Database;
	BROWSER: Fetcher;
	SEND_EMAIL: { send(message: unknown): Promise<void> };
	DISPATCHER: DispatchNamespace;
	WORDPRESS: Fetcher;
	ARTIFACTS?: Artifacts;
	Sandbox: DurableObjectNamespace<SandboxDO>;
	SandboxPool: DurableObjectNamespace<SandboxPool>;
	PersistentSandbox: DurableObjectNamespace<PersistentSandbox>;
	CLOUDFLARE_ACCOUNT_ID: string;
	CLOUDFLARE_API_TOKEN: string;
	CUSTOM_DOMAIN: string;
	DISPATCH_NAMESPACE: string;
	EMAIL_FROM: string;
	EMAIL_DOMAIN: string;
}
