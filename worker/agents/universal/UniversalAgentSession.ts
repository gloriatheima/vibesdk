import { DurableObject } from 'cloudflare:workers';
import { createLogger } from '../../logger';
import { runPlannerBrain, runExecutorBrain } from '../inferutils/workersai';
import type {
	AgentTaskPayload,
	SseEventType,
	ThinkingEventData,
	PlanEventData,
	ActionEventData,
	TextEventData,
	StatusEventData,
	DoneEventData,
	ErrorEventData,
} from './types';

type SsePayload =
	| { type: 'thinking'; data: ThinkingEventData }
	| { type: 'plan'; data: PlanEventData }
	| { type: 'action'; data: ActionEventData }
	| { type: 'text'; data: TextEventData }
	| { type: 'status'; data: StatusEventData }
	| { type: 'done'; data: DoneEventData }
	| { type: 'error'; data: ErrorEventData };

const logger = createLogger('UniversalAgentSession');

export class UniversalAgentSession extends DurableObject<Env> {
	private encoder = new TextEncoder();
	private sseWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
	// Events buffered before the SSE client connects
	private pendingEvents: SsePayload[] = [];
	private processing = false;

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname.endsWith('/stream')) {
			return this.handleSseStream();
		}

		return new Response('Not found', { status: 404 });
	}

	// RPC method called by the Queue consumer to start dual-brain processing.
	async processTask(payload: AgentTaskPayload): Promise<{ queued: boolean }> {
		logger.info('Task received by DO', { taskId: payload.taskId });

		if (this.processing) {
			logger.warn('Task rejected: already processing', { taskId: payload.taskId });
			return { queued: false };
		}

		this.processing = true;
		this.ctx.waitUntil(this.runDualBrain(payload));
		return { queued: true };
	}

	private handleSseStream(): Response {
		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		this.sseWriter = writable.getWriter();

		// Flush any events that arrived before the client connected.
		this.ctx.waitUntil(this.flushPendingEvents());

		return new Response(readable, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
				'X-Accel-Buffering': 'no',
			},
		});
	}

	private async flushPendingEvents(): Promise<void> {
		if (!this.sseWriter || this.pendingEvents.length === 0) return;
		const events = [...this.pendingEvents];
		this.pendingEvents = [];
		for (const ev of events) {
			await this.writeToSse(ev.type, ev.data);
		}
	}

	private async runDualBrain(payload: AgentTaskPayload): Promise<void> {
		try {
			await this.emit({ type: 'status', data: { message: 'Planning...' } });

			const plan = await runPlannerBrain(this.env, payload.instruction, {
				onThinking: async (chunk) => {
					await this.emit({ type: 'thinking', data: { content: chunk } });
				},
				onResponse: () => {},
			});

			await this.emit({ type: 'plan', data: plan });
			await this.emit({ type: 'status', data: { message: 'Executing...' } });

			await runExecutorBrain(this.env, payload.instruction, plan, {
				onAction: async (action) => {
					await this.emit({ type: 'action', data: action });
				},
				onText: async (chunk) => {
					await this.emit({ type: 'text', data: { content: chunk } });
				},
			});

			await this.emit({ type: 'done', data: { taskId: payload.taskId } });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error('Dual-brain processing failed', { error, taskId: payload.taskId });
			await this.emit({ type: 'error', data: { message } });
		} finally {
			this.processing = false;
			if (this.sseWriter) {
				await this.sseWriter.close().catch(() => {});
				this.sseWriter = null;
			}
		}
	}

	private async emit(event: SsePayload): Promise<void> {
		if (this.sseWriter) {
			await this.writeToSse(event.type, event.data);
		} else {
			this.pendingEvents.push(event);
		}
	}

	private async writeToSse(type: SseEventType | 'status', data: unknown): Promise<void> {
		if (!this.sseWriter) return;
		const chunk = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
		try {
			await this.sseWriter.write(this.encoder.encode(chunk));
		} catch {
			// Client disconnected
			this.sseWriter = null;
		}
	}
}
