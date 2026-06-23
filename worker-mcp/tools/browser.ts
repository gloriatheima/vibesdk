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
	{
		name: 'browser_content',
		description:
			'Fetch the fully JavaScript-rendered HTML of a page via Cloudflare Browser Rendering REST API. ' +
			'Returns raw HTML string (up to 50 KB). ' +
			'Compare: browse returns Markdown text (good for reading); browser_scrape extracts by CSS selector (good when selectors are known); browser_content returns raw HTML (good when you need to read the full page structure); extract_links extracts all hyperlinks as structured JSON (best for link/title extraction tasks).',
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'URL to render' },
				wait_for: { type: 'string', description: 'Optional single CSS selector to wait for before capturing HTML' },
			},
			required: ['url'],
		},
	},
	{
		name: 'extract_links',
		description:
			'Render a page with full JavaScript execution and extract all hyperlinks as structured JSON. ' +
			'Returns an array of {text, href} objects with relative URLs resolved to absolute. ' +
			'For richer extraction (H1, title, headings + links together), use web_scrape instead.',
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'URL to extract links from' },
				wait_for: { type: 'string', description: 'Optional CSS selector to wait for before extracting (e.g. "article", ".post-list")' },
			},
			required: ['url'],
		},
	},
	{
		name: 'web_scrape',
		description:
			'Render a web page with full JavaScript execution and extract structured content in code — no LLM parsing required. ' +
			'Returns a JSON object with page title, H1 headings, H2 headings, and links. ' +
			'FIRST CHOICE for any extraction task: "get H1 tag", "extract page title", "find article links", "list headings". ' +
			'Use extract=["h1"] to get only H1 headings, or omit extract to get title + h1 + h2 + links.',
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'URL to scrape' },
				extract: {
					type: 'array',
					description: 'Elements to extract. Options: "title", "h1", "h2", "h3", "links". Omit to get all.',
					items: { type: 'string' },
				},
				wait_for: { type: 'string', description: 'Optional CSS selector to wait for before extracting' },
			},
			required: ['url'],
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
		case 'browser_content':
			return runBrowserContent(args, env);
		case 'extract_links':
			return runExtractLinks(args, env);
		case 'web_scrape':
			return runWebScrape(args, env);
		default:
			throw new Error(`browser: unknown tool ${name}`);
	}
}

async function runExtractLinks(args: Record<string, unknown>, env: ToolServerEnv): Promise<string> {
	const url = str(args.url);
	if (!url) throw new Error('extract_links requires url');

	const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = env;
	if (!accountId || !apiToken) {
		throw new Error('extract_links requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets');
	}

	const body: Record<string, unknown> = { url, elements: [{ selector: 'a' }] };
	if (args.wait_for) {
		const sel = str(args.wait_for).split(',')[0].trim();
		if (sel) body.waitForSelector = { selector: sel };
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
		throw new Error(`extract_links ${resp.status}: ${errMsg ?? 'unknown error'}`);
	}

	const aResults = (json.result ?? []).find((e) => e.selector === 'a')?.results ?? [];

	let baseOrigin = '';
	try { baseOrigin = new URL(url).origin; } catch { /* ignore */ }

	const seen = new Set<string>();
	const links: Array<{ text: string; href: string }> = [];

	for (const el of aResults) {
		const text = el.text.trim();
		const rawHref = getScrapeAttr(el.attributes, 'href');
		if (!text || text.length < 2) continue;
		if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:')) continue;
		const href = rawHref.startsWith('/') && baseOrigin ? baseOrigin + rawHref : rawHref.startsWith('http') ? rawHref : null;
		if (!href || seen.has(href)) continue;
		seen.add(href);
		links.push({ text, href });
		if (links.length >= 100) break;
	}

	return JSON.stringify(links);
}

function getScrapeAttr(attrs: ScrapeAttribute[], name: string): string {
	return attrs.find((a) => a.name === name)?.value ?? '';
}

async function runWebScrape(args: Record<string, unknown>, env: ToolServerEnv): Promise<string> {
	const url = str(args.url);
	if (!url) throw new Error('web_scrape requires url');

	const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = env;
	if (!accountId || !apiToken) {
		throw new Error('web_scrape requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets');
	}

	const toExtract =
		Array.isArray(args.extract) && args.extract.length > 0
			? args.extract.map(String)
			: ['title', 'h1', 'h2', 'links'];
	const want = new Set(toExtract);

	const selectors: string[] = [];
	if (want.has('title')) selectors.push('title');
	if (want.has('h1')) selectors.push('h1');
	if (want.has('h2')) selectors.push('h2');
	if (want.has('h3')) selectors.push('h3');
	if (want.has('links')) selectors.push('a');

	const body: Record<string, unknown> = { url, elements: selectors.map((s) => ({ selector: s })) };
	if (args.wait_for) {
		const sel = str(args.wait_for).trim();
		if (sel) body.waitForSelector = { selector: sel };
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
		throw new Error(`web_scrape ${resp.status}: ${errMsg ?? 'unknown error'}`);
	}

	const elements = json.result ?? [];
	const result: Record<string, unknown> = { url };

	if (want.has('title')) {
		const rows = elements.find((e) => e.selector === 'title')?.results ?? [];
		result.title = rows[0]?.text?.trim() ?? null;
	}

	for (const tag of ['h1', 'h2', 'h3'] as const) {
		if (want.has(tag)) {
			const rows = elements.find((e) => e.selector === tag)?.results ?? [];
			result[tag] = rows.map((r) => r.text.trim()).filter(Boolean);
		}
	}

	if (want.has('links')) {
		const aRows = elements.find((e) => e.selector === 'a')?.results ?? [];
		let baseOrigin2 = '';
		try { baseOrigin2 = new URL(url).origin; } catch { /* ignore */ }

		const seen2 = new Set<string>();
		const linkList: Array<{ text: string; href: string }> = [];

		for (const el of aRows) {
			const text = el.text.trim();
			const rawHref = getScrapeAttr(el.attributes, 'href');
			if (!text || text.length < 2) continue;
			if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:')) continue;
			const href = rawHref.startsWith('/') && baseOrigin2
				? baseOrigin2 + rawHref
				: rawHref.startsWith('http') ? rawHref : null;
			if (!href || seen2.has(href)) continue;
			seen2.add(href);
			linkList.push({ text, href });
			if (linkList.length >= 100) break;
		}
		result.links = linkList;
	}

	return truncate(JSON.stringify(result));
}

async function runBrowserContent(args: Record<string, unknown>, env: ToolServerEnv): Promise<string> {
	const url = str(args.url);
	if (!url) throw new Error('browser_content requires url');

	const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = env;
	if (!accountId || !apiToken) {
		throw new Error('browser_content requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets');
	}

	const body: Record<string, unknown> = { url };
	if (args.wait_for) {
		const sel = str(args.wait_for).split(',')[0].trim();
		if (sel) body.waitForSelector = { selector: sel };
	}

	const resp = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/content`,
		{
			method: 'POST',
			headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
			body: JSON.stringify(body),
		},
	);

	const json = (await resp.json()) as BrowserRenderingResult;
	if (!resp.ok || json.success === false) {
		const errMsg = json.errors?.map((e) => e.message).filter(Boolean).join('; ');
		throw new Error(`browser_content ${resp.status}: ${errMsg ?? 'unknown error'}`);
	}

	return truncate(json.result ?? '', MAX_BROWSER_BYTES);
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

interface ScrapeAttribute {
	name: string;
	value: string;
}

interface ScrapeElementResult {
	text: string;
	html?: string;
	attributes: ScrapeAttribute[];
}

interface ScrapeElement {
	selector: string;
	results: ScrapeElementResult[];
}

interface ScrapeResult {
	success?: boolean;
	result?: ScrapeElement[];
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
		if (firstSelector) body.waitForSelector = { selector: firstSelector };
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

	return truncate(JSON.stringify(json.result ?? []), MAX_BROWSER_BYTES);
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
