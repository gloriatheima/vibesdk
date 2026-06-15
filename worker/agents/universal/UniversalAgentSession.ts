import { DurableObject } from 'cloudflare:workers';
import { createLogger } from '../../logger';
import { runPlannerBrain, runExecutorBrain, runReflectorBrain } from '../inferutils/workersai';
import { ToolExecutor } from './tools/executor';
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
	ToolResultEventData,
	ReflectEventData,
	ConversationTurn,
} from './types';

const MAX_ITERATIONS = 3;

type SsePayload =
	| { type: 'thinking'; data: ThinkingEventData }
	| { type: 'plan'; data: PlanEventData }
	| { type: 'action'; data: ActionEventData }
	| { type: 'result'; data: ToolResultEventData }
	| { type: 'reflect'; data: ReflectEventData }
	| { type: 'text'; data: TextEventData }
	| { type: 'status'; data: StatusEventData }
	| { type: 'done'; data: DoneEventData }
	| { type: 'error'; data: ErrorEventData };

const logger = createLogger('UniversalAgentSession');

export class UniversalAgentSession extends DurableObject<Env> {
	private encoder = new TextEncoder();
	private sseWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
	private pendingEvents: SsePayload[] = [];
	private processing = false;

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname.endsWith('/stream')) {
			return this.handleSseStream();
		}

		return new Response('Not found', { status: 404 });
	}

	async processTask(payload: AgentTaskPayload): Promise<{ queued: boolean }> {
		logger.info('Task received by DO', { taskId: payload.taskId });

		if (this.processing) {
			logger.warn('Task rejected: already processing', { taskId: payload.taskId });
			return { queued: false };
		}

		this.processing = true;
		this.ctx.waitUntil(this.runOrchestrationLoop(payload));
		return { queued: true };
	}

	private handleSseStream(): Response {
		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		this.sseWriter = writable.getWriter();

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

	// Full Planner → Executor → Tool → Reflect loop (up to MAX_ITERATIONS).
	private async runOrchestrationLoop(payload: AgentTaskPayload): Promise<void> {
		const toolExecutor = new ToolExecutor();
		const history: ConversationTurn[] = [];
		let currentInstruction = payload.instruction;

		try {
			for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
				logger.info('Orchestration iteration', { iteration, taskId: payload.taskId });

				// ── Phase A: Plan ──────────────────────────────────────────────────
				await this.emit({ type: 'status', data: { message: `Planning (iteration ${iteration + 1})...` } });

				const plan = await runPlannerBrain(this.env, currentInstruction, {
					onThinking: async (chunk) => {
						await this.emit({ type: 'thinking', data: { content: chunk } });
					},
					onResponse: () => {},
				});

				await this.emit({ type: 'plan', data: plan });

				// ── Phase B: Execute (Executor brain outputs action JSON) ──────────
				await this.emit({ type: 'status', data: { message: 'Executing plan...' } });

				const actions = await runExecutorBrain(this.env, currentInstruction, plan, {
					onAction: async (action) => {
						await this.emit({ type: 'action', data: action });
					},
					onText: async (chunk) => {
						await this.emit({ type: 'text', data: { content: chunk } });
					},
				});

				// ── Phase C: Run tools ─────────────────────────────────────────────
				await this.emit({ type: 'status', data: { message: 'Running tools...' } });

				const results: ToolResultEventData[] = [];
				for (const action of actions) {
					const result = await toolExecutor.run(action);
					results.push(result);
					await this.emit({ type: 'result', data: result });
				}

				history.push({ plan, results });

				// ── Phase D: Reflect ───────────────────────────────────────────────
				await this.emit({ type: 'status', data: { message: 'Reflecting...' } });

				const reflection = await runReflectorBrain(this.env, payload.instruction, history, {
					onThinking: async (chunk) => {
						await this.emit({ type: 'thinking', data: { content: chunk } });
					},
				});

				await this.emit({
					type: 'reflect',
					data: { isDone: reflection.isDone, summary: reflection.summary, iteration },
				});

				if (reflection.isDone) {
					logger.info('Task marked done by reflector', { iteration, taskId: payload.taskId });
					break;
				}

				if (reflection.nextInstruction) {
					currentInstruction = reflection.nextInstruction;
				}
			}

			await this.emit({ type: 'done', data: { taskId: payload.taskId } });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error('Orchestration loop failed', { error, taskId: payload.taskId });
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
			this.sseWriter = null;
		}
	}
}
