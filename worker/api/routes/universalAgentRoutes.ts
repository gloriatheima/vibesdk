import { Hono } from 'hono';
import { AppEnv } from '../../types/appenv';
import { AuthConfig, setAuthLevel, enforceAuthRequirement } from '../../middleware/auth/routeAuth';
import { generateId } from '../../utils/idGenerator';
import type { AgentTaskPayload } from '../../agents/universal/types';
import type { UniversalAgentSession } from '../../agents/universal/UniversalAgentSession';

export function setupUniversalAgentRoutes(app: Hono<AppEnv>): void {
	// ========================================
	// DEV TEST — remove before production
	// GET /api/universal/_test/stream?instruction=...
	// Bypasses auth+queue; calls DO directly to verify dual-brain + SSE.
	// ========================================
	app.get('/api/universal/_test/stream', setAuthLevel(AuthConfig.public), async (c) => {
		const instruction = c.req.query('instruction') ?? 'Write a hello world Python script';
		const sessionId = generateId();
		const taskId = generateId();

		const payload: AgentTaskPayload = {
			taskId,
			sessionId,
			userId: 'dev-test',
			instruction,
			timestamp: Date.now(),
		};

		const doId = c.env.UniversalAgentSession.idFromName(sessionId);
		const stub = c.env.UniversalAgentSession.get(doId) as DurableObjectStub<UniversalAgentSession>;

		// Kick off processing before opening the stream so events are buffered in DO.
		c.executionCtx.waitUntil(stub.processTask(payload));

		const streamUrl = new URL(c.req.url);
		streamUrl.pathname = '/stream';
		return stub.fetch(new Request(streamUrl.toString(), { headers: { Accept: 'text/event-stream' } }));
	});

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

			return c.json({ taskId, sessionId }, 202);
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
