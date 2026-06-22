import { Sandbox } from '@cloudflare/sandbox';

export class PersistentSandbox extends Sandbox {
	sleepAfter = '20m';
}
