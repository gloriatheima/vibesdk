import { Hono } from 'hono';
import { AppEnv } from '../../types/appenv';
import { AuthConfig, setAuthLevel, enforceAuthRequirement } from '../../middleware/auth/routeAuth';
import { generateId } from '../../utils/idGenerator';
import type { AgentTaskPayload } from '../../agents/universal/types';
import type { UniversalAgentSession } from '../../agents/universal/UniversalAgentSession';
import { successResponse } from '../responses';

export function setupUniversalAgentRoutes(app: Hono<AppEnv>): void {
	// ========================================
	// UNIVERSAL AGENT ROUTES
	// ========================================

	// Submit a task: enqueue it and return the session ID for SSE streaming.
	app.post(
		'/api/universal/tasks',
		setAuthLevel(AuthConfig.authenticated),
		async (c) => {
			const authResult = await enforceAuthRequirement(c);
			if (authResult) return authResult;

			const user = c.get('user');
			if (!user) {
				return c.json({ error: 'Unauthorized' }, 401);
			}

			let body: { instruction?: string };
			try {
				body = await c.req.json<{ instruction?: string }>();
			} catch {
				return c.json({ error: 'Invalid JSON body' }, 400);
			}

			const { instruction } = body;
			if (!instruction || typeof instruction !== 'string' || instruction.trim().length === 0) {
				return c.json({ error: 'instruction is required' }, 400);
			}

			const taskId = generateId();
			const sessionId = generateId();

			const payload: AgentTaskPayload = {
				taskId,
				sessionId,
				userId: user.id,
				instruction: instruction.trim(),
				timestamp: Date.now(),
			};

			await c.env.AGENT_TASK_QUEUE.send(payload);

			return c.json({ success: true, data: { taskId, sessionId } }, 202);
		},
	);

	// List files written to R2 for a session.
	app.get(
		'/api/universal/sessions/:sessionId/files',
		setAuthLevel(AuthConfig.authenticated),
		async (c) => {
			const authResult = await enforceAuthRequirement(c);
			if (authResult) return authResult;

			const sessionId = c.req.param('sessionId');
			const prefix = `sessions/${sessionId}/`;
			const list = await c.env.SESSION_FILES_BUCKET.list({ prefix });
			const files = list.objects.map(obj => ({
				path: obj.key.slice(prefix.length),
				size: obj.size,
				uploaded: obj.uploaded.toISOString(),
			}));
			return successResponse({ files });
		},
	);

	// Return content of a specific session file from R2.
	app.get(
		'/api/universal/sessions/:sessionId/files/*',
		setAuthLevel(AuthConfig.authenticated),
		async (c) => {
			const authResult = await enforceAuthRequirement(c);
			if (authResult) return authResult;

			const sessionId = c.req.param('sessionId');
			const marker = '/files/';
			const markerIdx = c.req.path.indexOf(marker);
			const filePath = markerIdx >= 0 ? c.req.path.slice(markerIdx + marker.length).replace(/^\/+/, '') : '';
			if (!filePath) return c.json({ error: 'file path is required' }, 400);

			const key = `sessions/${sessionId}/${filePath}`;
			const object = await c.env.SESSION_FILES_BUCKET.get(key);
			if (!object) return c.json({ error: 'File not found' }, 404);

			const content = await object.text();
			return successResponse({ path: filePath, content });
		},
	);

	// Deploy session files as an App via CodeGeneratorAgent sandbox pipeline.
	app.post(
		'/api/universal/sessions/:sessionId/deploy',
		setAuthLevel(AuthConfig.authenticated),
		async (c) => {
			const authResult = await enforceAuthRequirement(c);
			if (authResult) return authResult;

			const user = c.get('user');
			if (!user) return c.json({ error: 'Unauthorized' }, 401);

			const sessionId = c.req.param('sessionId');
			if (!sessionId) return c.json({ error: 'sessionId is required' }, 400);

			let instruction = '';
			try {
				const body = await c.req.json<{ instruction?: string }>();
				instruction = body.instruction?.trim() ?? '';
			} catch { /* instruction stays empty */ }

			const doId = c.env.UniversalAgentSession.idFromName(sessionId);
			const stub = c.env.UniversalAgentSession.get(doId) as DurableObjectStub<UniversalAgentSession>;

			const result = await stub.deploySession(user.id, instruction, sessionId);
			if (!result.appId) {
				return c.json({ error: 'No files found for this session' }, 404);
			}

			return c.json({ appId: result.appId, previewUrl: result.previewUrl });
		},
	);

	// Serve session files from R2 with correct MIME types for browser preview.
	app.get(
		'/api/universal/sessions/:sessionId/preview/*',
		setAuthLevel(AuthConfig.authenticated),
		async (c) => {
			const authResult = await enforceAuthRequirement(c);
			if (authResult) return authResult;

			const sessionId = c.req.param('sessionId');
			let filePath = c.req.param('*') || 'index.html';
			if (!filePath || filePath === '/') filePath = 'index.html';

			const key = `sessions/${sessionId}/${filePath.replace(/^\/+/, '')}`;
			const object = await c.env.SESSION_FILES_BUCKET.get(key);
			if (!object) return c.text('Not Found', 404);

			const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
			const mimeMap: Record<string, string> = {
				html: 'text/html; charset=utf-8',
				css: 'text/css',
				js: 'application/javascript',
				mjs: 'application/javascript',
				json: 'application/json',
				svg: 'image/svg+xml',
				png: 'image/png',
				jpg: 'image/jpeg',
				jpeg: 'image/jpeg',
				ico: 'image/x-icon',
				woff2: 'font/woff2',
				woff: 'font/woff',
			};
			const contentType = mimeMap[ext] ?? 'text/plain; charset=utf-8';

			const body = await object.arrayBuffer();
			return new Response(body, {
				headers: {
					'Content-Type': contentType,
					'Cache-Control': 'no-store',
				},
			});
		},
	);

	// SSE stream: proxy from the UniversalAgentSession DO for a given session.
	app.get(
		'/api/universal/sessions/:sessionId/stream',
		setAuthLevel(AuthConfig.authenticated),
		async (c) => {
			const authResult = await enforceAuthRequirement(c);
			if (authResult) return authResult;

			const sessionId = c.req.param('sessionId');
			if (!sessionId) {
				return c.json({ error: 'sessionId is required' }, 400);
			}

			const doId = c.env.UniversalAgentSession.idFromName(sessionId);
			const stub = c.env.UniversalAgentSession.get(doId) as DurableObjectStub<UniversalAgentSession>;

			// Construct a request to the DO's /stream endpoint
			const streamUrl = new URL(c.req.url);
			streamUrl.pathname = '/stream';

			return stub.fetch(new Request(streamUrl.toString(), {
				headers: { 'Accept': 'text/event-stream' },
			}));
		},
	);
}
