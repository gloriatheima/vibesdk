import { createLogger } from '../../../logger';
import type { ActionEventData, ToolResultEventData } from '../types';

const logger = createLogger('ToolExecutor');

export class ToolExecutor {
	private fileSystem = new Map<string, string>();

	async run(action: ActionEventData): Promise<ToolResultEventData> {
		try {
			const output = await this.dispatch(action);
			logger.info('Tool executed', { tool: action.tool, step: action.step });
			return { step: action.step, tool: action.tool, success: true, output };
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.warn('Tool failed', { tool: action.tool, step: action.step, error: msg });
			return { step: action.step, tool: action.tool, success: false, output: '', error: msg };
		}
	}

	private async dispatch(action: ActionEventData): Promise<string> {
		const p = action.params;

		switch (action.tool) {
			case 'file_write': {
				const filename = String(p.filename ?? '');
				const content = String(p.content ?? '');
				if (!filename) throw new Error('file_write requires filename');
				this.fileSystem.set(filename, content);
				return `Written ${content.length} chars to '${filename}'`;
			}

			case 'file_read': {
				const filename = String(p.filename ?? '');
				const content = this.fileSystem.get(filename);
				if (content === undefined) throw new Error(`File '${filename}' not found`);
				return content;
			}

			case 'file_list': {
				const files = [...this.fileSystem.keys()];
				return files.length ? files.join('\n') : '(empty)';
			}

			case 'http_fetch': {
				const url = String(p.url ?? '');
				const method = String(p.method ?? 'GET').toUpperCase();
				const body = p.body !== undefined ? String(p.body) : undefined;
				if (!url) throw new Error('http_fetch requires url');
				const resp = await fetch(url, { method, body });
				const text = await resp.text();
				return `HTTP ${resp.status}\n${text.slice(0, 3000)}`;
			}

			case 'shell_exec': {
				// Phase 3: replaced with Cloudflare Sandbox RPC call
				const command = String(p.command ?? '');
				return `[Phase 3 stub] shell_exec: ${command}`;
			}

			case 'browser_navigate': {
				// Phase 3: replaced with Cloudflare Browser Rendering
				const url = String(p.url ?? '');
				return `[Phase 3 stub] browser_navigate: ${url}`;
			}

			case 'email_send': {
				// Phase 3: replaced with Email Routing API
				const to = String(p.to ?? '');
				const subject = String(p.subject ?? '');
				return `[Phase 3 stub] email_send to=${to} subject=${subject}`;
			}

			case 'sandbox_run': {
				// Phase 3: replaced with Cloudflare Sandbox container
				const code = String(p.code ?? '');
				return `[Phase 3 stub] sandbox_run: ${code.slice(0, 100)}`;
			}

			default:
				return `[Unknown tool: ${action.tool}]`;
		}
	}

	getFiles(): Map<string, string> {
		return this.fileSystem;
	}
}
