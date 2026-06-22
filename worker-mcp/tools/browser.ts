import type { McpTool } from '../../worker/agents/universal/mcp/types';
import type { ToolServerEnv } from '../env';
import { truncate, str } from '../utils';

const MAX_BROWSER_BYTES = 50_000;

interface BrowserRenderingResult {
	success?: boolean;
	result?: string;
	errors?: Array<{ message?: string }>;
}

export const TOOL_DEFINITIONS: McpTool[] = [
	{
		name: 'browse',
		description: 'Navigate a URL and return the page content as Markdown. Preferred for reading web pages.',
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'URL to visit' },
			},
			required: ['url'],
		},
	},
	{
		name: 'browser_navigate',
		description: "Navigate browser to a URL. format='content'(default) returns raw HTML text; format='markdown' returns Markdown.",
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'URL to visit' },
				format: { type: 'string', enum: ['content', 'markdown'], description: "Output format" },
			},
			required: ['url'],
		},
	},
	{
		name: 'browser_screenshot',
		description: 'Take a screenshot of a URL and return a base64 PNG data URL.',
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'URL to screenshot' },
				width: { type: 'string', description: 'Viewport width in pixels (default 1280)' },
				height: { type: 'string', description: 'Viewport height in pixels (default 900)' },
			},
			required: ['url'],
		},
	},
	{
		name: 'browser_scrape',
		description:
			'Extract structured data from a URL using CSS selectors. Renders the full page with JavaScript before extracting. ' +
			'Use for scraping JavaScript-heavy sites, SPAs, or when you need specific fields from a page. ' +
			'For simple article reading use browse instead. ' +
			'Returns an array of matched elements per selector with their text and attributes.',
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'URL to scrape' },
				selectors: {
					type: 'array',
					description: 'CSS selectors to extract. Each entry is a selector string, e.g. "h1", ".price", "table.results td".',
					items: { type: 'string' },
				},
				wait_for: { type: 'string', description: 'Optional CSS selector to wait for before extracting (useful for lazy-loaded content)' },
			},
			required: ['url', 'selectors'],
		},
	},
];

export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	env: ToolServerEnv,
): Promise<string> {
	switch (name) {
		case 'browse':
			return runBrowserNavigate({ ...args, format: 'markdown' }, env);
		case 'browser_navigate':
			return runBrowserNavigate(args, env);
		case 'browser_screenshot':
			return runBrowserScreenshot(args, env);
		case 'browser_scrape':
			return runBrowserScrape(args, env);
		default:
			throw new Error(`browser: unknown tool ${name}`);
	}
}

async function runBrowserNavigate(args: Record<string, unknown>, env: ToolServerEnv): Promise<string> {
	const url = str(args.url);
	if (!url) throw new Error('browser_navigate requires url');

	const format = str(args.format || 'content');
	const endpoint = format === 'markdown' ? 'markdown' : 'content';

	const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = env;
	if (!accountId || !apiToken) {
		throw new Error('browser_navigate requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets');
	}

	const resp = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/${endpoint}`,
		{
			method: 'POST',
			headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({ url }),
		},
	);

	const json = (await resp.json()) as BrowserRenderingResult;
	if (!resp.ok || json.success === false) {
		const errMsg = json.errors?.map((e) => e.message).filter(Boolean).join('; ');
		throw new Error(`browser rendering ${resp.status}: ${errMsg ?? 'unknown error'}`);
	}

	return truncate(json.result ?? '', MAX_BROWSER_BYTES);
}

interface ScrapeElement {
	selector: string;
	results: Array<{ text: string; attributes: Record<string, string> }>;
}

interface ScrapeResult {
	success?: boolean;
	result?: { elements: ScrapeElement[] };
	errors?: Array<{ message?: string }>;
}

async function runBrowserScrape(args: Record<string, unknown>, env: ToolServerEnv): Promise<string> {
	const url = str(args.url);
	if (!url) throw new Error('browser_scrape requires url');

	let rawSelectors: unknown = args.selectors;
	if (typeof rawSelectors === 'string') {
		try { rawSelectors = JSON.parse(rawSelectors); } catch { /* ignore */ }
		if (typeof rawSelectors === 'string') {
			rawSelectors = rawSelectors.split(',').map((s) => s.trim()).filter(Boolean);
		}
	}
	if (rawSelectors !== null && typeof rawSelectors === 'object' && !Array.isArray(rawSelectors)) {
		rawSelectors = Object.values(rawSelectors as Record<string, string>)
			.flatMap(v => String(v).split(',').map(s => s.trim()).filter(Boolean));
	}
	if (!Array.isArray(rawSelectors) || rawSelectors.length === 0) {
		throw new Error('browser_scrape requires a non-empty selectors array');
	}

	const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = env;
	if (!accountId || !apiToken) {
		throw new Error('browser_scrape requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets');
	}

	const elements = rawSelectors.map((s) => {
		const entry: Record<string, string> = { selector: str(s) };
		return entry;
	});

	const body: Record<string, unknown> = { url, elements };
	if (args.wait_for) {
		const firstSelector = str(args.wait_for).split(',')[0].trim();
		if (firstSelector) body.waitForSelector = firstSelector;
	}

	const resp = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/scrape`,
		{
			method: 'POST',
			headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
			body: JSON.stringify(body),
		},
	);

	const json = (await resp.json()) as ScrapeResult;
	if (!resp.ok || json.success === false) {
		const errMsg = json.errors?.map((e) => e.message).filter(Boolean).join('; ');
		throw new Error(`browser_scrape ${resp.status}: ${errMsg ?? JSON.stringify(json).slice(0, 200)}`);
	}

	return truncate(JSON.stringify(json.result?.elements ?? []), MAX_BROWSER_BYTES);
}

async function runBrowserScreenshot(args: Record<string, unknown>, env: ToolServerEnv): Promise<string> {
	const url = str(args.url);
	if (!url) throw new Error('browser_screenshot requires url');

	const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = env;
	if (!accountId || !apiToken) {
		throw new Error('browser_screenshot requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets');
	}

	const width = Number(args.width ?? 1280);
	const height = Number(args.height ?? 900);

	const resp = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/screenshot`,
		{
			method: 'POST',
			headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({ url, viewport: { width, height } }),
		},
	);

	if (!resp.ok) {
		const text = await resp.text().catch(() => resp.statusText);
		throw new Error(`browser screenshot ${resp.status}: ${text.slice(0, 200)}`);
	}

	const buffer = await resp.arrayBuffer();
	const bytes = new Uint8Array(buffer);

	const CHUNK = 8192;
	let binary = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	const b64 = btoa(binary);
	const dataUrl = `data:image/png;base64,${b64}`;

	return truncate(
		`Screenshot of ${url} (${bytes.length} bytes, ${width}x${height})\n${dataUrl}`,
		MAX_BROWSER_BYTES,
	);
}
