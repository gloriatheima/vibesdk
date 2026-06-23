import { createLogger } from '../../logger';
import type { ActionEventData, PlanEventData, ConversationTurn } from '../universal/types';

const logger = createLogger('WorkersAI');

export const PLANNER_MODEL = '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b';
export const EXECUTOR_MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';
export const CLAUDE_MODEL = 'claude-sonnet-4-5';
export const CLAUDE_HAIKU_MODEL = 'claude-haiku-4-5';

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
	model = CLAUDE_MODEL,
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
			model,
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

Available tools — grouped by category. Choose the most appropriate tool based on what the task actually requires.

[TEXT RESPONSE]
- direct_response(content) — use when the ENTIRE task is answered by generating text alone (e.g. tell a joke, write a poem, explain a concept, translate text, answer a factual question). No files written, no code executed, no external services called. NEVER use to ask for clarification.

[WEB & HTTP]
- browse(url) — navigate to a URL and return the page as clean Markdown. PREFERRED for reading articles, docs, or any static web page. Fast, no JS execution.
- browser_navigate(url, format?) — like browse but with format control: 'content' (default) returns raw HTML; 'markdown' returns Markdown. Use when browse output is insufficient.
- browser_screenshot(url, width?, height?) — take a screenshot of a URL, returns base64 PNG. Use when visual output or layout inspection is needed.
- browser_scrape(url, selectors, wait_for?) — fully render the page (JavaScript executed) then extract structured data via CSS selectors. Returns matched elements with text and attributes.
- browser_content(url, wait_for?) — fully render the page and return the raw HTML string. Use when you need flexible parsing (e.g. Python + BeautifulSoup in sandbox_run) or when CSS selectors are uncertain. Returns up to 50 KB of HTML.
- http_fetch(url, method?, body?) — make a raw HTTP request and return the full response. Use when you need POST/PUT/DELETE or need the raw response headers/status.

[EMAIL]
- email_send(to, subject, body, from?, html?) — send an email using the platform's built-in email service. This is the ONLY way to send emails — never use shell commands like mail, sendmail, or curl. 'body' is the required plain-text fallback. If sending an HTML page or formatted content, put the full HTML in the 'html' param — do NOT put raw HTML tags or markdown code fences in 'body'.
- email_inbox(limit?, since_ms?) — list received emails for this session.
- email_read(id) — read the full body of an email by message_id.

[SESSION FILE STORAGE — no sandbox required, instant]
- file_write(filename, content) — write a file to persistent session storage (served via the preview URL and visible in the Code tab). Use for ALL output files the user should see or download: HTML pages, CSS, JavaScript, markdown reports, JSON data, config files, README files. This does NOT require a sandbox container. Prefer this over sandbox_write whenever the file does not need to be executed inside a sandbox_run step.
- file_read(filename) — read a file previously written with file_write.
- file_list() — list all files in session storage.

[PLATFORM WORKERS & SERVICES]
- call_worker(name, path, method?, body?, headers?) — invoke a Worker already deployed in the platform dispatch namespace. Returns { status, body }.
- call_service(binding, path, method?, body?, headers?) — call a private internal service via Workers VPC binding (e.g. internal databases, WordPress, ClickHouse). Binding names are ALWAYS UPPERCASE (e.g. use "WORDPRESS" not "wordpress"). For WordPress REST API use paths like /wp-json/wp/v2/posts?per_page=5.
- worker_deploy(name, script) — deploy a Cloudflare Worker ES module to the platform dispatch namespace. Returns { name, url } where url is the permanent public HTTPS URL (https://{name}.vibesdk.gloriatrials.com). The script must export default { async fetch(request, env, ctx) {} }. Use for: REST APIs, GraphQL, WebSocket servers, full-stack apps (API + embedded frontend). CRITICAL: when embedding HTML inside the script string, use single-quoted string concatenation (never template literals with backticks) to avoid JS syntax errors caused by backticks in HTML attributes or CSS.

[GIT ARTIFACTS — currently unavailable, do not use these tools]
- artifact_create, artifact_get_token, artifact_list, artifact_delete — NOT available in this environment. If the task requires saving source code, use file_write to save each file so the user can access them from the Code tab.

[SANDBOX — requires container, has cold-start delay; only use when code must actually run]
- shell_exec(command, timeout?) — run a single stateless command in the sandbox (Ubuntu 22.04, Node 20, Python 3.11, git). State does NOT persist between shell_exec calls. Use for quick one-off commands. Returns { stdout, stderr, exitCode, success }.
- sandbox_run(command, envVars?, timeout?) — run a command in a PERSISTENT sandbox container where state carries over between calls (installed packages, env vars, cwd). Use for multi-step workflows: install deps → write code → run → inspect output. Pass envVars once to set variables that persist for future calls.
- sandbox_write(path, content) — write a file to the sandbox container filesystem. Use ONLY when the file must be read or executed inside a sandbox_run or shell_exec call (e.g. Python scripts, shell scripts, Dockerfiles). For files the user should preview, use file_write instead. The content param MUST be the complete file — never a placeholder.
- sandbox_read(path) — read a file from the sandbox container filesystem. Use to inspect files created by sandbox_run.

[PLATFORM CONSTRAINTS — things Claude cannot infer on its own]

- file_write writes directly to session storage with no container — instant, no cold-start, available in preview immediately.
- sandbox_run state does NOT persist between tool calls. Do not try to keep a server process running inside sandbox_run.
- Cloudflare Workers have a ~1 MB script size limit. Avoid bundling large frontend build artifacts (Vite/CRA dist) into a Worker script — load UI from CDN instead (unpkg, esm.sh).
- worker_deploy gives a permanent public HTTPS URL instantly: https://{name}.vibesdk.gloriatrials.com.
- When reading sandbox_run file output via cat or echo, output is truncated at ~10 KB. Use sandbox_read to get full file content reliably.
- Cloudflare Workers run as ES modules. The script must use 'export default { async fetch(request, env, ctx) {} }'.

Think in terms of real software projects. Do not generate boilerplate from scratch. Instead:
1. SCAFFOLD: Use sandbox_run with the right generator for the stack:
   - React/Vue/Svelte SPA → npx create-vite@latest my-app -- --template react-ts (or vue-ts, svelte-ts)
   - Next.js → npx create-next-app@latest my-app --typescript --tailwind --app
   - Express API → npx express-generator my-api && cd my-api && npm install
   - Python FastAPI → pip install fastapi uvicorn && sandbox_write main.py
   - Python Flask → pip install flask && sandbox_write app.py
   - Static site with no build step → skip scaffolding, use file_write directly
2. CUSTOMIZE: Use sandbox_write to write only the files that differ from the scaffold (components, routes, business logic, styles). Never rewrite package.json or config files the generator already created correctly.
3. INSTALL DEPS: sandbox_run "cd my-app && npm install <extra-packages>" for any libraries beyond the scaffold defaults (e.g. react-router-dom, axios, zustand, tailwindcss, framer-motion).
4. BUILD: sandbox_run the build command (npm run build, vite build, python -m pytest, etc.).
5. EXPORT to preview: After building, copy dist output to session file storage so the user can see it:
   - Vite/CRA: sandbox_run "find my-app/dist -type f" to enumerate, then file_write each file with its content read via sandbox_read.
   - Python/Node services that must stay running: use direct_response to give the user the run command — they cannot be served as static previews.
6. GIT (optional): For deliverable source code, use artifact_create then push with sandbox_run git commands.

Do NOT hand-write React/Vue boilerplate (main.tsx, vite.config.ts, tsconfig.json, index.html) — the scaffolder creates these correctly. Only write the application-specific code the user asked for.

Only use the tools listed above. When a step involves writing code or content, include the COMPLETE content in the params — never leave it empty or as a placeholder.

NEVER plan a direct_response step whose content depends on data fetched by a prior tool step (browse, browser_*, http_fetch, sandbox_run, call_service, call_worker). The Executor cannot know what those tools will return. Use file_write to save fetched data instead.

For tasks requiring call_service or call_worker followed by file_write: plan ONLY the call_service/call_worker step. The Reflector will carry the response data forward to the next iteration where file_write can be planned with the actual content.

For WordPress VPC calls via call_service, pass headers: '{"Host": "wordpress.gloriatrials.com"}' (or the actual WordPress domain) so WordPress generates correct permalink URLs instead of service.local URLs.
For WordPress REST API queries that only need titles and links, add \`_fields=id,title,link,date\` to the query string (e.g. /wp-json/wp/v2/posts?per_page=5&_fields=id,title,link,date) to get a compact response without full post content.

For tasks that only require reading or extracting content from a URL (e.g. get titles, links, summaries):
- For STATIC pages (plain HTML, API endpoints): use browse or http_fetch as a SINGLE step. The Reflector will read the output and extract the answer directly.
- For DYNAMIC/JS-rendered pages (React/Vue SPAs, blogs like blog.cloudflare.com, news sites): use browser_content(url) instead of browse or http_fetch. browser_content uses a headless Chromium browser that executes JavaScript, so it can see content that browse/http_fetch cannot.
- Do NOT add file_write or sandbox_run after browse/browser_content just to 'format' results — the Reflector handles that.

CRITICAL — NEVER INVENT DATA: If a data-fetching tool (browse, browser_content, http_fetch, browser_scrape) does not return the specific items requested (article titles, prices, listings), you MUST NOT write a file containing made-up data. Do NOT write placeholder HTML with fake article names or fake URLs. Instead, report failure in a direct_response step and let the Reflector decide the next approach.

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

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export function fixVerbatimIdentifiers(text: string, instruction: string): string {
	const sourceEmails = instruction.match(EMAIL_RE) ?? [];
	if (sourceEmails.length === 0) return text;
	return text.replace(EMAIL_RE, (found) => {
		const exact = sourceEmails.find(e => e.toLowerCase() === found.toLowerCase());
		if (exact) return exact;
		const foundDomain = found.split('@')[1]?.toLowerCase() ?? '';
		const sameDomain = sourceEmails.find(e => e.split('@')[1]?.toLowerCase() === foundDomain);
		return sameDomain ?? found;
	});
}

function parsePlanBlueprint(raw: string, fallbackInstruction: string): PlanEventData {
	const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
	const match = withoutThink.match(/\{[\s\S]*\}/);
	if (match) {
		try {
			const fixed = fixVerbatimIdentifiers(match[0], fallbackInstruction);
			const parsed = JSON.parse(fixed) as Partial<PlanEventData>;
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
				tool: 'direct_response',
				params: { content: `Unable to generate a plan for: ${fallbackInstruction.slice(0, 200)}` },
			},
		],
		summary: fallbackInstruction.slice(0, 100),
	};
}

const EXECUTOR_SYSTEM_PROMPT = `You are a precise task executor for an autonomous AI agent.
You receive a JSON task plan. For each step, output a single-line JSON action object:

{ "step": <step_index>, "tool": "<tool_name>", "params": { ... } }

One JSON object per line. No markdown, no explanations, no extra text.

RULES:
- Follow the plan exactly. Execute every step.
- Each action MUST be a single line. Use JSON escape sequences (\\n for newlines) — NEVER actual newlines inside a JSON string value.
- All param values must be concrete — NEVER use template variables like {{step1.output}}. Generate all content yourself.
- For sandbox_write, generate complete file content inline. Use absolute paths like /workspace/app.py.
- For browser_scrape, selectors must be a JSON array: ["h2 a", ".price"]. Never use an object.
- For worker_deploy, the script must be a valid Cloudflare Worker ES module. All code on one line (\\n for breaks). Minimal Hono example: import{Hono}from'https://esm.sh/hono@3';const app=new Hono();app.get('/',(c)=>c.json({ok:true}));export default app;
- Copy all identifiers (email, URL, phone, filename) exactly as written in the plan.
- Never use direct_response to ask for clarification. Never skip steps.
- NEVER fabricate data in direct_response that was supposed to come from a tool call result. If a prior step fetches external data (browse, browser_*, http_fetch, sandbox_run), do NOT pre-write what that data will be — only direct_response with content you know from training data.`;

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

	const stream = await runClaudeStream(env, EXECUTOR_SYSTEM_PROMPT, messages[1].content, 8192, CLAUDE_HAIKU_MODEL);
	const collectedActions: ActionEventData[] = [];
	let lineBuffer = '';

	const tryParseAction = async (line: string): Promise<void> => {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) return;
		try {
			const action = JSON.parse(trimmed) as Partial<ActionEventData> & Record<string, unknown>;
			if (typeof action.step === 'number' && typeof action.tool === 'string') {
				const params: Record<string, unknown> = { ...(action.params ?? {}) };
				const knownKeys = new Set(['step', 'tool', 'params']);
				for (const [k, v] of Object.entries(action)) {
					if (!knownKeys.has(k)) params[k] = v;
				}
				const evt: ActionEventData = {
					step: action.step,
					tool: action.tool,
					params: params as ActionEventData['params'],
				};
				collectedActions.push(evt);
				await callbacks.onAction(evt);
			}
		} catch {
			// Incomplete JSON line; wait for more tokens
		}
	};

	let insideThink = false;
	for await (const token of parseAnthropicSse(stream)) {
		if (token.includes('<think>')) { insideThink = true; }
		if (insideThink) {
			if (token.includes('</think>')) insideThink = false;
			continue;
		}
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

Key rules:
1. If a tool step returned data that directly answers the original instruction, mark isDone=true. CRITICAL: the summary field MUST contain the actual extracted data — titles, URLs, prices, post content, etc. — not just a statement like "Successfully fetched X". Extract and format the real data from the tool result into the summary. For example if posts were fetched, list each post title and link in the summary. The summary IS the user-facing output shown in the UI.
   EXCEPTION: If the original instruction explicitly asks for a formatted file output (e.g. '整理成列表', '保存', '写入文件', 'save to file', 'format as list', 'write a report'), do NOT mark isDone=true until a file_write step has successfully written real non-placeholder content. If the data was retrieved but not yet written to a file, set isDone=false and write a nextInstruction that says: "Write a formatted markdown file with the following content: [paste the actual retrieved data here]".
   IMPORTANT for summary format: use a numbered or bulleted list when presenting multiple items. Include all relevant fields (title, URL, date, etc.) visible in the tool result.
   When the result is a list of titled links, populate the "items" array with {title, url} pairs copied verbatim from the tool output. The UI renders items as a structured list.
2. If a step's output contains a non-zero exitCode, "command not found", "permission denied", HTTP error codes (4xx/5xx), "Invalid input", or other error signals, that step did NOT fulfill its intended goal — even if the tool call itself technically returned a result. Reason about whether the overall task was still achieved despite the failure.
3. If the task was not fully accomplished due to step failures, set isDone=false and write a nextInstruction that proposes a different approach or a different tool from the available set that could accomplish the same goal.
4. CRITICAL — detect fabricated results: If a data-fetching step (browse, browser_*, http_fetch, sandbox_run, call_service) FAILED or returned no relevant structured data, and a subsequent step (direct_response, sandbox_write, file_write) presents content that appears to contain the data that step was supposed to fetch (e.g. article titles, URLs, scraped content), that content is fabricated and not real. Specific signs of fabrication in written files: sequential URL patterns like /article1, /article2, /article3; placeholder titles like 'Understanding DNS Security', 'HTTP/3 Performance Guide'; titles or URLs that do NOT appear anywhere in any tool output. Set isDone=false and write a nextInstruction to retry using browser_content (headless JS browser) instead of browse or http_fetch.
5. CRITICAL — detect placeholder files: If a file_write step wrote content containing placeholder text (e.g. '等待', 'waiting', '更新', 'placeholder', 'TODO', 'Step 2 has been executed with a placeholder'), the file does NOT contain real data. Set isDone=false and write a nextInstruction to call the data-fetching tool again and write the actual formatted content to the file.

Output ONLY valid JSON:
{
  "isDone": true | false,
  "summary": "Brief summary of what was accomplished",
  "items": [{"title": "...", "url": "..."}],
  "nextInstruction": "Only include this key if isDone is false"
}

The "items" field is optional. Populate it ONLY when the task result is a list of titled links (articles, posts, search results, etc.) — copy title and url verbatim from the tool output. Omit "items" for tasks that produce code, files, or non-link content. Omit "nextInstruction" when isDone is true.

No markdown. No explanation. Only the JSON object.`;

export type ReflectorCallbacks = {
	onThinking: (chunk: string) => Promise<void>;
};

export interface ReflectorItem {
	title: string;
	url: string;
}

export interface ReflectorResult {
	isDone: boolean;
	summary: string;
	items?: ReflectorItem[];
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
	const result = parseReflectorResult(stripped);
	if (result.nextInstruction) {
		result.nextInstruction = fixVerbatimIdentifiers(result.nextInstruction, instruction);
	}
	return result;
}

function parseReflectorResult(raw: string): ReflectorResult {
	const match = raw.match(/\{[\s\S]*\}/);
	if (match) {
		try {
			const parsed = JSON.parse(match[0]) as Partial<ReflectorResult>;
			if (typeof parsed.isDone === 'boolean' && typeof parsed.summary === 'string') {
				const items = Array.isArray(parsed.items)
					? parsed.items.filter(
							(it): it is ReflectorItem =>
								typeof it === 'object' &&
								it !== null &&
								typeof (it as ReflectorItem).title === 'string' &&
								typeof (it as ReflectorItem).url === 'string',
						)
					: undefined;
				return {
					isDone: parsed.isDone,
					summary: parsed.summary,
					items: items && items.length > 0 ? items : undefined,
					nextInstruction: parsed.nextInstruction,
				};
			}
		} catch {
			logger.warn('Failed to parse reflector JSON, defaulting to done');
		}
	}
	return { isDone: true, summary: 'Task execution complete (reflector parse fallback)' };
}
