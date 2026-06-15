import { createLogger } from '../../logger';
import type { ActionEventData, PlanEventData, ConversationTurn } from '../universal/types';

const logger = createLogger('WorkersAI');

export const PLANNER_MODEL = '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b';
export const EXECUTOR_MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';

type ChatMessage = {
	role: 'system' | 'user' | 'assistant';
	content: string;
};

type WorkersAiChunk = {
	response?: string;
};

// State machine that splits deepseek-r1 output into <think>...</think> vs response content.
// Handles partial tag tokens split across stream chunks.
class ThinkingStreamParser {
	private state: 'preamble' | 'thinking' | 'response' = 'preamble';
	private buffer = '';

	process(
		token: string,
		onThinking: (chunk: string) => void,
		onResponse: (chunk: string) => void,
	): void {
		this.buffer += token;

		if (this.state === 'preamble') {
			const idx = this.buffer.indexOf('<think>');
			if (idx !== -1) {
				if (idx > 0) onResponse(this.buffer.slice(0, idx));
				this.buffer = this.buffer.slice(idx + 7);
				this.state = 'thinking';
				this.drainThinking(onThinking, onResponse);
			} else if (this.buffer.length > 7) {
				// Keep last 6 chars in case a '<think>' tag is split at the boundary
				const safe = this.buffer.slice(0, -6);
				if (safe) onResponse(safe);
				this.buffer = this.buffer.slice(-6);
			}
		} else if (this.state === 'thinking') {
			this.drainThinking(onThinking, onResponse);
		} else {
			onResponse(this.buffer);
			this.buffer = '';
		}
	}

	flush(onThinking: (chunk: string) => void, onResponse: (chunk: string) => void): void {
		if (!this.buffer) return;
		if (this.state === 'thinking') {
			onThinking(this.buffer);
		} else {
			onResponse(this.buffer);
		}
		this.buffer = '';
	}

	private drainThinking(
		onThinking: (chunk: string) => void,
		onResponse: (chunk: string) => void,
	): void {
		const endIdx = this.buffer.indexOf('</think>');
		if (endIdx !== -1) {
			if (endIdx > 0) onThinking(this.buffer.slice(0, endIdx));
			this.buffer = this.buffer.slice(endIdx + 8);
			this.state = 'response';
			if (this.buffer) {
				onResponse(this.buffer);
				this.buffer = '';
			}
		} else if (this.buffer.length > 8) {
			// Keep last 7 chars in case '</think>' is split at the boundary
			const safe = this.buffer.slice(0, -7);
			if (safe) onThinking(safe);
			this.buffer = this.buffer.slice(-7);
		}
	}
}

// Calls Workers AI with stream:true and returns the raw ReadableStream.
// Cast is required because the typed overloads don't narrow on stream:true.
async function runWorkersAiStream(
	ai: Ai,
	model: string,
	messages: ChatMessage[],
	maxTokens = 8096,
): Promise<ReadableStream<Uint8Array>> {
	const run = ai.run.bind(ai) as (
		model: string,
		input: Record<string, unknown>,
	) => Promise<ReadableStream<Uint8Array>>;

	return run(model, { messages, stream: true, max_tokens: maxTokens });
}

// Parses the SSE-formatted chunks emitted by Workers AI streaming into plain text tokens.
async function* parseWorkersAiSse(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let lineBuffer = '';

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			lineBuffer += decoder.decode(value, { stream: true });
			const lines = lineBuffer.split('\n');
			lineBuffer = lines.pop() ?? '';

			for (const line of lines) {
				if (!line.startsWith('data: ')) continue;
				const payload = line.slice(6).trim();
				if (payload === '[DONE]') return;

				let chunk: WorkersAiChunk;
				try {
					chunk = JSON.parse(payload) as WorkersAiChunk;
				} catch {
					continue;
				}

				if (chunk.response) {
					yield chunk.response;
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

const PLANNER_SYSTEM_PROMPT = `You are a task planner for an autonomous AI agent platform.
Analyze the user instruction carefully inside a <think> block, then output ONLY a valid JSON blueprint.

Blueprint format:
{
  "steps": [
    { "index": 1, "description": "...", "tool": "<tool_name>", "params": { "key": "value" } }
  ],
  "summary": "One-line description of what will be accomplished"
}

Available tools: sandbox_run, browser_navigate, email_send, file_write, file_read, shell_exec, http_fetch

Output nothing except the JSON blueprint after the thinking block. No markdown, no explanation.`;

export type PlannerCallbacks = {
	onThinking: (chunk: string) => Promise<void>;
	onResponse: (chunk: string) => void;
};

export async function runPlannerBrain(
	env: Env,
	instruction: string,
	callbacks: PlannerCallbacks,
): Promise<PlanEventData> {
	logger.info('Planner brain starting', { model: PLANNER_MODEL });

	const messages: ChatMessage[] = [
		{ role: 'system', content: PLANNER_SYSTEM_PROMPT },
		{ role: 'user', content: instruction },
	];

	const stream = await runWorkersAiStream(env.AI, PLANNER_MODEL, messages, 8096);
	const parser = new ThinkingStreamParser();
	let fullResponse = '';

	for await (const token of parseWorkersAiSse(stream)) {
		parser.process(
			token,
			(chunk) => {
				callbacks.onThinking(chunk).catch((err) => logger.error('onThinking callback error', { err }));
			},
			(chunk) => {
				fullResponse += chunk;
				callbacks.onResponse(chunk);
			},
		);
	}

	parser.flush(
		(chunk) => {
			callbacks.onThinking(chunk).catch((err) => logger.error('onThinking flush error', { err }));
		},
		(chunk) => {
			fullResponse += chunk;
			callbacks.onResponse(chunk);
		},
	);

	return parsePlanBlueprint(fullResponse, instruction);
}

function parsePlanBlueprint(raw: string, fallbackInstruction: string): PlanEventData {
	const match = raw.match(/\{[\s\S]*\}/);
	if (match) {
		try {
			const parsed = JSON.parse(match[0]) as Partial<PlanEventData>;
			if (Array.isArray(parsed.steps) && typeof parsed.summary === 'string') {
				return parsed as PlanEventData;
			}
		} catch {
			logger.warn('Failed to parse blueprint JSON, using fallback plan');
		}
	}
	return {
		steps: [
			{
				index: 1,
				description: fallbackInstruction.slice(0, 200),
				tool: 'shell_exec',
				params: {},
			},
		],
		summary: fallbackInstruction.slice(0, 100),
	};
}

const EXECUTOR_SYSTEM_PROMPT = `You are a precise task executor for an autonomous AI agent.
You receive a JSON task plan. For each step, output a single-line JSON action object:

{ "step": <step_index>, "tool": "<tool_name>", "params": { ... } }

One JSON object per line. No markdown, no explanations, no extra text.`;

export type ExecutorCallbacks = {
	onAction: (action: ActionEventData) => Promise<void>;
	onText: (chunk: string) => Promise<void>;
};

export async function runExecutorBrain(
	env: Env,
	instruction: string,
	plan: PlanEventData,
	callbacks: ExecutorCallbacks,
): Promise<ActionEventData[]> {
	logger.info('Executor brain starting', { model: EXECUTOR_MODEL, steps: plan.steps.length });

	const messages: ChatMessage[] = [
		{ role: 'system', content: EXECUTOR_SYSTEM_PROMPT },
		{
			role: 'user',
			content: `Original instruction: ${instruction}\n\nPlan:\n${JSON.stringify(plan, null, 2)}\n\nExecute each step:`,
		},
	];

	const stream = await runWorkersAiStream(env.AI, EXECUTOR_MODEL, messages, 4096);
	const collectedActions: ActionEventData[] = [];
	let lineBuffer = '';

	const tryParseAction = async (line: string): Promise<void> => {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) return;
		try {
			const action = JSON.parse(trimmed) as Partial<ActionEventData>;
			if (typeof action.step === 'number' && typeof action.tool === 'string') {
				const evt: ActionEventData = {
					step: action.step,
					tool: action.tool,
					params: action.params ?? {},
				};
				collectedActions.push(evt);
				await callbacks.onAction(evt);
			}
		} catch {
			// Incomplete JSON line; wait for more tokens
		}
	};

	for await (const token of parseWorkersAiSse(stream)) {
		await callbacks.onText(token);

		lineBuffer += token;
		const lines = lineBuffer.split('\n');
		lineBuffer = lines.pop() ?? '';

		for (const line of lines) {
			await tryParseAction(line);
		}
	}

	// Flush any trailing content that had no final newline
	if (lineBuffer.trim()) {
		await tryParseAction(lineBuffer);
	}

	return collectedActions;
}

const REFLECTOR_SYSTEM_PROMPT = `You are a task completion evaluator for an autonomous AI agent.
You receive the original instruction, a completed execution plan, and the tool results from running each step.
Evaluate whether the overall task is complete or if further steps are needed.

Output ONLY valid JSON:
{
  "isDone": true | false,
  "summary": "One-sentence summary of what was accomplished or what still needs to be done",
  "nextInstruction": "Only include this key if isDone is false — a rephrased instruction for the next iteration"
}

No markdown. No explanation. Only the JSON object.`;

export type ReflectorCallbacks = {
	onThinking: (chunk: string) => Promise<void>;
};

export interface ReflectorResult {
	isDone: boolean;
	summary: string;
	nextInstruction?: string;
}

export async function runReflectorBrain(
	env: Env,
	instruction: string,
	history: ConversationTurn[],
	callbacks: ReflectorCallbacks,
): Promise<ReflectorResult> {
	logger.info('Reflector brain starting', { model: PLANNER_MODEL, turns: history.length });

	const historyText = history
		.map((turn, i) => {
			const resultsText = turn.results
				.map((r) =>
					r.success
						? `Step ${r.step} (${r.tool}): OK — ${r.output.slice(0, 300)}`
						: `Step ${r.step} (${r.tool}): FAILED — ${r.error}`,
				)
				.join('\n');
			return `--- Iteration ${i + 1} ---\nPlan summary: ${turn.plan.summary}\nResults:\n${resultsText}`;
		})
		.join('\n\n');

	const messages: ChatMessage[] = [
		{ role: 'system', content: REFLECTOR_SYSTEM_PROMPT },
		{
			role: 'user',
			content: `Original instruction: ${instruction}\n\n${historyText}`,
		},
	];

	const stream = await runWorkersAiStream(env.AI, PLANNER_MODEL, messages, 2048);
	const parser = new ThinkingStreamParser();
	let fullResponse = '';

	for await (const token of parseWorkersAiSse(stream)) {
		parser.process(
			token,
			(chunk) => {
				callbacks.onThinking(chunk).catch((err) => logger.error('reflector onThinking error', { err }));
			},
			(chunk) => {
				fullResponse += chunk;
			},
		);
	}

	parser.flush(
		(chunk) => {
			callbacks.onThinking(chunk).catch((err) => logger.error('reflector flush error', { err }));
		},
		(chunk) => {
			fullResponse += chunk;
		},
	);

	return parseReflectorResult(fullResponse);
}

function parseReflectorResult(raw: string): ReflectorResult {
	const match = raw.match(/\{[\s\S]*\}/);
	if (match) {
		try {
			const parsed = JSON.parse(match[0]) as Partial<ReflectorResult>;
			if (typeof parsed.isDone === 'boolean' && typeof parsed.summary === 'string') {
				return {
					isDone: parsed.isDone,
					summary: parsed.summary,
					nextInstruction: parsed.nextInstruction,
				};
			}
		} catch {
			logger.warn('Failed to parse reflector JSON, defaulting to done');
		}
	}
	return { isDone: true, summary: 'Task execution complete (reflector parse fallback)' };
}
