import type { ActionEventData } from '../types';

export class ToolExecutor {
	constructor(
		private readonly env: Env,
		private readonly sessionId: string,
	) {}

	private r2Key(filename: string): string {
		return `sessions/${this.sessionId}/${filename}`;
	}

	async runLocal(action: ActionEventData): Promise<string> {
		const p = action.params;

		switch (action.tool) {
			case 'file_write': {
				const filename = String(p.filename ?? '');
				const content = String(p.content ?? '');
				if (!filename) throw new Error('file_write requires filename');
				await this.env.SESSION_FILES_BUCKET.put(this.r2Key(filename), content);
				return `Written ${content.length} chars to '${filename}'`;
			}

			case 'file_read': {
				const filename = String(p.filename ?? '');
				const object = await this.env.SESSION_FILES_BUCKET.get(this.r2Key(filename));
				if (!object) throw new Error(`File '${filename}' not found`);
				return object.text();
			}

			case 'file_list': {
				const prefix = `sessions/${this.sessionId}/`;
				const list = await this.env.SESSION_FILES_BUCKET.list({ prefix });
				const names = list.objects.map(o => o.key.slice(prefix.length));
				return names.length ? names.join('\n') : '(empty)';
			}

			default:
				throw new Error(`ToolExecutor: unknown local tool '${action.tool}'`);
		}
	}
}
