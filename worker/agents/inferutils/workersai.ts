import { createLogger } from '../../logger';
import type { ActionEventData, PlanEventData, ConversationTurn } from '../universal/types';

const logger = createLogger('WorkersAI');

export const PLANNER_MODEL = '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b';
export const EXECUTOR_MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';
export const CLAUDE_MODEL = 'claude-sonnet-4-5';

type ChatMessage = {
	role: 'system' | 'user' | 'assistant';
	content: string;
};

type WorkersAiChunk = {
	response?: string;
};

type AnthropicChunk = {
	type: string;
	delta?: { type: string; text?: string };
};

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

// Parses Anthropic SSE stream (content_block_delta events) into plain text tokens.
async function* parseAnthropicSse(
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

				let chunk: AnthropicChunk;
				try {
					chunk = JSON.parse(payload) as AnthropicChunk;
				} catch {
					continue;
				}

				if (
					chunk.type === 'content_block_delta' &&
					chunk.delta?.type === 'text_delta' &&
					chunk.delta.text
				) {
					yield chunk.delta.text;
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

// Calls claude-sonnet-4-5 via Cloudflare AI Gateway Unified Billing.
// Constructs the endpoint from CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AI_GATEWAY slug.
// No Anthropic key needed — billed from Cloudflare AI Gateway credits.
async function runClaudeStream(
	env: Env,
	systemPrompt: string,
	userMessage: string,
	maxTokens = 8096,
): Promise<ReadableStream<Uint8Array>> {
	const url = `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.CLOUDFLARE_AI_GATEWAY}/anthropic/v1/messages`;

	const resp = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'cf-aig-authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify({
			model: CLAUDE_MODEL,
			max_tokens: maxTokens,
			system: systemPrompt,
			messages: [{ role: 'user', content: userMessage }],
			stream: true,
		}),
	});

	if (!resp.ok || !resp.body) {
		const errText = await resp.text().catch(() => '');
		throw new Error(`Claude API ${resp.status}: ${errText}`);
	}

	return resp.body;
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

Available tools and their key params:
- http_fetch(url, method?, body?) — fetch any URL and return raw HTTP response
- browser_navigate(url, format?) — navigate browser; format='content'(default)|'markdown'
- browse(url) — navigate and return page as Markdown (preferred for reading web content)
- browser_screenshot(url, width?, height?) — take a screenshot, returns base64 PNG data URL
- email_send(to, subject, body, from?, html?) — send an outbound email via SEND_EMAIL binding
- email_inbox(limit?, since_ms?) — list received emails for this session
- email_read(id) — read full body of an inbox message by message_id
- file_write(filename, content) — write content to in-memory file
- file_read(filename) — read in-memory file
- file_list() — list all in-memory files
- call_worker(name, path, method?, body?, headers?) — call a Worker in the platform dispatch namespace (Workers for Platforms)
- call_service(binding, path, method?, body?, headers?) — call a private internal service via Workers VPC binding
- artifact_create(name, description?) — create a versioned git repo in Cloudflare Artifacts; returns { remote, writeToken, authRemote, readToken, defaultBranch }. Use authRemote inside a sandbox for git push. Give readToken to the user for git clone.
- artifact_get_token(name, scope?, ttl?) — mint a new access token for an existing Artifacts repo; scope="read"|"write", ttl in seconds
- artifact_list(limit?) — list all Artifacts repos in the namespace
- artifact_delete(name) — permanently delete an Artifacts repo
- sandbox_run(command, envVars?, timeout?) — execute a shell command in the session sandbox container (Ubuntu 22.04, Node 20, Python 3.11, git pre-installed). Container is persistent per session. Pass envVars once to set env vars that persist for all future sandbox_run calls (e.g. { "ARTIFACTS_GIT_REMOTE": authRemote } before git push). Returns { stdout, stderr, exitCode, success }.
- sandbox_write(path, content) — write a file directly to the sandbox container filesystem at the given absolute path. Safer than heredoc for large files. IMPORTANT: the "content" param MUST contain the complete, fully-written file content — never a placeholder or description.
- sandbox_read(path) — read a file from the sandbox container filesystem.
- direct_response(content) — use this ONLY when the task is purely conversational or informational with NO side effects needed (e.g. tell a story, write a poem, explain a concept, answer a question). NEVER use direct_response to ask the user for clarification or more information.

IMPORTANT: Only use the tools listed above. Do NOT invent tool names or assume any other tools exist. If the result from a previous step already contains the answer, you do NOT need another tool step — the data can be read directly from the step result. When a step involves writing code, include the COMPLETE code in the params — never leave content empty or as a description.

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
	logger.info('Planner brain starting', { model: CLAUDE_MODEL });

	await callbacks.onThinking('Analyzing task...\n');

	const stream = await runClaudeStream(env, PLANNER_SYSTEM_PROMPT, instruction, 8096);

	let fullResponse = '';
	for await (const token of parseAnthropicSse(stream)) {
		fullResponse += token;
		callbacks.onResponse(token);
	}

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

One JSON object per line. No markdown, no explanations, no extra text.

CRITICAL RULES:
- ALWAYS follow the plan exactly. Execute every step as specified.
- For sandbox_write steps, generate the COMPLETE file content yourself based on the step description. Never leave content empty.
- NEVER use direct_response to ask the user for clarification or more information. If a step is unclear, make your best attempt to execute it.
- NEVER skip steps or replace code-execution steps with direct_response.`;

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

	const stream = await runWorkersAiStream(env.AI, EXECUTOR_MODEL, messages, 512);
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

Key rule: If a tool step returned data that directly answers the original instruction, mark isDone=true and include the answer in the summary. Do NOT ask for more steps just to format or re-read data that is already in the results — extract it yourself.

Output ONLY valid JSON:
{
  "isDone": true | false,
  "summary": "Summary of what was accomplished, including key data from results if relevant",
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

	await callbacks.onThinking('Reflecting on results...\n');

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
		{ role: 'user', content: `Original instruction: ${instruction}\n\n${historyText}` },
	];

	const stream = await runWorkersAiStream(env.AI, PLANNER_MODEL, messages, 1024);

	let fullResponse = '';
	for await (const token of parseWorkersAiSse(stream)) {
		fullResponse += token;
	}

	// deepseek-r1 emits <think>...</think> before the JSON — strip it.
	const stripped = fullResponse.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
	return parseReflectorResult(stripped);
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
