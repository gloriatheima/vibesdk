import { useEffect, useRef, useState } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router';
import {
	ArrowLeft,
	Check,
	AlertTriangle,
	Loader,
	LoaderCircle,
	ChevronDown,
	ChevronRight,
	Code,
	Eye,
	Rocket,
	TerminalSquare,
	RefreshCw,
	Activity,
} from 'lucide-react';
import clsx from 'clsx';
import type {
	ThinkingEventData,
	PlanEventData,
	ActionEventData,
	ToolResultEventData,
	ReflectEventData,
	ReflectItem,
	DoneEventData,
	ErrorEventData,
	StatusEventData,
	FileEventData,
	DeployReadyEventData,
	SessionFileEntry,
} from '@/api-types';
import { apiClient } from '@/lib/api-client';
import { CodePanel } from './CodePanel';

interface ActionEntry {
	action: ActionEventData;
	result: ToolResultEventData | null;
}

type AgentStatus = 'connecting' | 'running' | 'done' | 'error';

interface AgentState {
	agentStatus: AgentStatus;
	statusMessage: string;
	thinkingText: string;
	plan: PlanEventData | null;
	actionLog: ActionEntry[];
	reflections: ReflectEventData[];
	files: SessionFileEntry[];
	deployReady: DeployReadyEventData | null;
	error: string | null;
	rawEvents: RawSseEvent[];
}

type RawSseEvent = { ts: number; type: string; summary: string };

function summarizeSseEvent(type: string, data: unknown): string {
	const d = data as Record<string, unknown>;
	switch (type) {
		case 'thinking': return String(d.content ?? '').slice(0, 80);
		case 'status': return String(d.message ?? '');
		case 'plan': {
			const steps = Array.isArray(d.steps) ? d.steps.length : '?';
			return `${steps} steps — ${String(d.summary ?? '').slice(0, 60)}`;
		}
		case 'action': return `${String(d.tool ?? '')}  step ${String(d.step ?? '')}`;
		case 'result': return `step ${String(d.step ?? '')} ${d.success ? '✓ OK' : `✗ ${String(d.error ?? '').slice(0, 60)}`}`;
		case 'reflect': return `isDone=${String(d.isDone ?? '')}  ${String(d.summary ?? '').slice(0, 60)}`;
		case 'file': return `${String(d.path ?? '')} (${String(d.size ?? '')}B)`;
		case 'deploy_ready': return `${String(d.fileCount ?? '')} files ready`;
		case 'done': return 'Task complete';
		case 'error': return String(d.message ?? '');
		default: return JSON.stringify(data).slice(0, 80);
	}
}

function applyEvent(state: AgentState, type: string, data: unknown): AgentState {
	switch (type) {
		case 'thinking': {
			const d = data as ThinkingEventData;
			return { ...state, thinkingText: state.thinkingText + d.content };
		}
		case 'status': {
			const d = data as StatusEventData;
			return { ...state, statusMessage: d.message };
		}
		case 'plan': {
			const d = data as PlanEventData;
			return { ...state, plan: d };
		}
		case 'action': {
			const d = data as ActionEventData;
			return { ...state, actionLog: [...state.actionLog, { action: d, result: null }] };
		}
		case 'result': {
			const d = data as ToolResultEventData;
			return {
				...state,
				actionLog: state.actionLog.map(entry =>
					entry.action.step === d.step && entry.result === null
						? { ...entry, result: d }
						: entry,
				),
			};
		}
		case 'reflect': {
			const d = data as ReflectEventData;
			return { ...state, reflections: [...state.reflections, d], thinkingText: '' };
		}
		case 'done': {
			const _d = data as DoneEventData;
			void _d;
			return { ...state, agentStatus: 'done', statusMessage: 'Complete' };
		}
		case 'error': {
			const d = data as ErrorEventData;
			return { ...state, agentStatus: 'error', error: d.message };
		}
		case 'file': {
			const d = data as FileEventData;
			const exists = state.files.some(f => f.path === d.path);
			const files = exists
				? state.files.map(f => f.path === d.path ? { ...f, size: d.size } : f)
				: [...state.files, { path: d.path, size: d.size }];
			return { ...state, files };
		}
		case 'deploy_ready': {
			const d = data as DeployReadyEventData;
			return { ...state, deployReady: d };
		}
		default:
			return state;
	}
}

function useAgentStream(sessionId: string) {
	const [state, setState] = useState<AgentState>({
		agentStatus: 'connecting',
		statusMessage: 'Connecting...',
		thinkingText: '',
		plan: null,
		actionLog: [],
		reflections: [],
		files: [],
		deployReady: null,
		error: null,
		rawEvents: [],
	});

	useEffect(() => {
		if (!sessionId) return;
		apiClient.getSessionFiles(sessionId).then(res => {
			if (res.data?.files?.length) {
				setState(s => {
					const merged = [...s.files];
					for (const f of res.data!.files) {
						if (!merged.some(e => e.path === f.path)) merged.push(f);
					}
					return { ...s, files: merged };
				});
			}
		}).catch(() => {});
	}, [sessionId]);

	useEffect(() => {
		if (!sessionId) return;
		const controller = new AbortController();

		async function consume() {
			try {
				const response = await fetch(`/api/universal/sessions/${sessionId}/stream`, {
					credentials: 'include',
					headers: { Accept: 'text/event-stream' },
					signal: controller.signal,
				});

				if (!response.ok) {
					setState(s => ({ ...s, agentStatus: 'error', error: `HTTP ${response.status}` }));
					return;
				}

				setState(s => ({ ...s, agentStatus: 'running', statusMessage: 'Running...' }));

				const reader = response.body!.getReader();
				const decoder = new TextDecoder();
				let buffer = '';

				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });

					const chunks = buffer.split('\n\n');
					buffer = chunks.pop() ?? '';

					for (const chunk of chunks) {
						const eventMatch = chunk.match(/^event: (.+)$/m);
						const dataMatch = chunk.match(/^data: (.+)$/m);
						if (!eventMatch || !dataMatch) continue;
						const eventType = eventMatch[1].trim();
						let data: unknown;
						try {
							data = JSON.parse(dataMatch[1]);
						} catch {
							continue;
						}
						setState(s => ({
						...applyEvent(s, eventType, data),
						rawEvents: [...s.rawEvents, { ts: Date.now(), type: eventType, summary: summarizeSseEvent(eventType, data) }],
					}));
					}
				}
			} catch (err) {
				if ((err as Error).name === 'AbortError') return;
				setState(s => ({ ...s, agentStatus: 'error', error: String(err) }));
			}
		}

		consume();
		return () => controller.abort();
	}, [sessionId]);

	return state;
}

function clampText(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) + '…' : text;
}

function ToolStatusEntry({ entry }: { entry: ActionEntry }) {
	const [expanded, setExpanded] = useState(false);
	const { action, result } = entry;
	const pending = result === null;
	const canExpand = !pending;
	const statusText = pending ? 'Running' : result.success ? 'Completed' : 'Error';
	const StatusIcon = pending ? LoaderCircle : result.success ? Check : AlertTriangle;
	const iconCls = pending
		? 'size-3 animate-spin text-text-tertiary'
		: result.success
			? 'size-3 text-green-500'
			: 'size-3 text-red-400';

	return (
		<div className="flex flex-col gap-1.5">
			<button
				type="button"
				onClick={() => canExpand && setExpanded(e => !e)}
				className={clsx(
					'flex items-center gap-1.5 text-xs text-text-tertiary',
					canExpand && 'cursor-pointer hover:text-text-secondary transition-colors',
				)}
				disabled={!canExpand}
			>
				<StatusIcon className={iconCls} />
				<span className="font-mono tracking-tight">
					{statusText} <span className="text-text-secondary">{action.tool}</span>
				</span>
				{canExpand && (
					expanded
						? <ChevronDown className="size-3 ml-0.5" />
						: <ChevronRight className="size-3 ml-0.5" />
				)}
			</button>
			{expanded && (
				<div className="ml-4 p-2.5 rounded-md text-xs font-mono border border-border-primary/30 bg-bg-1/50 overflow-auto max-h-64 space-y-2">
					<div>
						<div className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">Input</div>
						<pre className="text-text-secondary whitespace-pre-wrap break-all">
							{JSON.stringify(action.params, null, 2)}
						</pre>
					</div>
					{result && (
						<div>
							<div className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">Output</div>
							<pre className={clsx('whitespace-pre-wrap break-all', result.success ? 'text-text-secondary' : 'text-red-400')}>
								{clampText(result.output || result.error || '', 800)}
							</pre>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

const EVENT_COLORS: Record<string, string> = {
	thinking: 'text-gray-400',
	status: 'text-gray-400',
	plan: 'text-blue-400',
	action: 'text-yellow-400',
	result: 'text-green-400',
	reflect: 'text-purple-400',
	file: 'text-cyan-400',
	deploy_ready: 'text-cyan-400',
	done: 'text-green-400',
	error: 'text-red-400',
};

function SseStreamPanel({ events, isRunning }: { events: RawSseEvent[]; isRunning: boolean }) {
	const bottomRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [events.length]);

	return (
		<div className="flex-1 overflow-y-auto font-mono text-xs bg-bg-1 p-3 space-y-0.5">
			{events.length === 0 ? (
				<p className="text-text-tertiary italic p-2">No events yet…</p>
			) : (
				events.map((ev, i) => {
					const t = new Date(ev.ts);
					const time = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}.${String(t.getMilliseconds()).padStart(3,'0')}`;
					return (
						<div key={i} className="flex items-start gap-2 leading-relaxed">
							<span className="text-text-tertiary flex-shrink-0">{time}</span>
							<span className={clsx('flex-shrink-0 w-20 font-semibold', EVENT_COLORS[ev.type] ?? 'text-text-secondary')}>{ev.type}</span>
							<span className="text-text-secondary break-all">{ev.summary}</span>
						</div>
					);
				})
			)}
			{isRunning && <div className="flex items-center gap-1.5 text-text-tertiary pt-1"><Loader className="size-3 animate-spin" /><span>streaming…</span></div>}
			<div ref={bottomRef} />
		</div>
	);
}

export default function AgentPage() {
	const { sessionId } = useParams<{ sessionId: string }>();
	const location = useLocation();
	const navigate = useNavigate();
	const instruction = (location.state as { instruction?: string } | null)?.instruction ?? '';

	const chatRef = useRef<HTMLDivElement>(null);

	const { agentStatus, statusMessage, thinkingText, plan, actionLog, reflections, files, deployReady, error, rawEvents } =
		useAgentStream(sessionId ?? '');

	const [view, setView] = useState<'preview' | 'code' | 'stream'>('preview');
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [deploying, setDeploying] = useState(false);
	const [previewKey, setPreviewKey] = useState(0);

	const handleDeploy = async () => {
		if (!sessionId || deploying) return;
		setDeploying(true);
		const result = await apiClient.deployAgentSession(sessionId, instruction);
		setDeploying(false);
		if (result.data?.previewUrl) window.open(result.data.previewUrl, '_blank');
	};

	const htmlFile = files.find(f => f.path.endsWith('.html'));
	const previewEntryPath = htmlFile?.path.replace(/^\/+/, '') ?? 'index.html';
	const sandboxEntries = actionLog.filter(e =>
		['sandbox_write', 'sandbox_run', 'shell_exec', 'sandbox_read', 'direct_response'].includes(e.action.tool),
	);
	const hasSandboxResult = sandboxEntries.some(e => e.result !== null);
	const isRunning = agentStatus === 'connecting' || agentStatus === 'running';

	const hasHtmlFile = !!htmlFile;
	const doneReflect = [...reflections].reverse().find((r: ReflectEventData) => r.isDone) ?? null;
	const autoSwitched = useRef(false);
	useEffect(() => {
		if ((hasHtmlFile || hasSandboxResult || doneReflect) && !autoSwitched.current) {
			autoSwitched.current = true;
			setView('preview');
		}
	}, [hasHtmlFile, hasSandboxResult, doneReflect]);

	useEffect(() => {
		chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
	}, [actionLog.length, reflections.length, thinkingText]);

	if (!sessionId) {
		return <div className="p-8 text-text-secondary text-sm">Invalid session.</div>;
	}

	return (
		<div className="size-full flex flex-col min-h-0 text-text-primary bg-bg-1">
			{/* Header */}
			<div className="flex-shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-border-primary bg-bg-2">
				<button
					type="button"
					onClick={() => navigate('/')}
					className="flex items-center gap-1.5 text-text-tertiary hover:text-text-primary transition-colors p-1 rounded"
					aria-label="Back to home"
				>
					<ArrowLeft className="size-4" />
				</button>
				<div className="flex-1 min-w-0">
					{instruction ? (
						<p className="text-sm font-medium text-text-primary truncate">{instruction}</p>
					) : (
						<p className="text-sm text-text-tertiary">Session {sessionId.slice(0, 8)}…</p>
					)}
				</div>
				{deployReady && (
					<button
						type="button"
						onClick={() => void handleDeploy()}
						disabled={deploying}
						className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
					>
						{deploying ? <Loader className="size-3 animate-spin" /> : <Rocket className="size-3" />}
						{deploying ? 'Deploying…' : `Deploy (${deployReady.fileCount} files)`}
					</button>
				)}
				<span className={clsx(
					'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
					agentStatus === 'connecting' && 'bg-text-primary/10 text-text-secondary',
					agentStatus === 'running' && 'bg-accent/10 text-accent',
					agentStatus === 'done' && 'bg-green-500/10 text-green-500',
					agentStatus === 'error' && 'bg-red-500/10 text-red-500',
				)}>
					{isRunning && <Loader className="size-3 animate-spin" />}
					{agentStatus === 'done' && <Check className="size-3" />}
					{agentStatus === 'error' && <AlertTriangle className="size-3" />}
					{error ?? statusMessage}
				</span>
			</div>

			{/* Main */}
			<div className="flex-1 flex min-h-0 overflow-hidden justify-center">
				{/* Left: chat panel */}
				<div
					ref={chatRef}
					className="w-80 flex-shrink-0 flex flex-col overflow-y-auto border-r border-border-primary pt-5 px-4 pb-6 gap-5 text-sm"
				>
					{/* User message */}
					<div className="flex gap-3">
						<div className="pl-0.5 flex-shrink-0">
							<div className="size-6 flex items-center justify-center rounded-full bg-accent text-white">
								<span className="text-xs font-medium">U</span>
							</div>
						</div>
						<div className="flex flex-col gap-1 min-w-0">
							<div className="font-medium text-text-primary">You</div>
							<p className="text-text-primary/80 leading-relaxed break-words">
								{instruction || `Session ${sessionId.slice(0, 8)}`}
							</p>
						</div>
					</div>

					{/* Agent message */}
					{(actionLog.length > 0 || isRunning || reflections.length > 0) && (
						<div className="flex gap-3">
							<div className="pl-0.5 flex-shrink-0">
								<div className="size-6 flex items-center justify-center rounded-full bg-[#f6821f]/10 border border-[#f6821f]/30">
									<span className="text-xs font-semibold text-[#f6821f]">O</span>
								</div>
							</div>
							<div className="flex flex-col gap-2 min-w-0 flex-1">
								<div className="font-medium text-text-primary">Agent</div>
								{plan && (
									<p className="text-xs text-text-secondary leading-relaxed">{plan.summary}</p>
								)}
								<div className="flex flex-col gap-2">
									{actionLog.map((entry, i) => (
										<ToolStatusEntry key={i} entry={entry} />
									))}
								</div>
								{thinkingText && isRunning && (
									<p className="text-xs text-text-tertiary italic font-mono leading-relaxed mt-1">
										{clampText(thinkingText, 300)}
									</p>
								)}
								{reflections.map((r, i) => (
									<div key={i} className={clsx(
										'text-xs mt-1',
										r.isDone ? 'text-green-500 font-medium' : 'text-text-secondary',
									)}>
										{r.summary}
									</div>
								))}
								{agentStatus === 'done' && (
									<div className="flex items-center gap-1.5 text-xs text-green-500 font-medium mt-1">
										<Check className="size-3" />
										Task Complete
									</div>
								)}
								{agentStatus === 'error' && (
									<div className="flex items-center gap-1.5 text-xs text-red-400 font-medium mt-1">
										<AlertTriangle className="size-3" />
										{error}
									</div>
								)}
							</div>
						</div>
					)}
				</div>

				{/* Right: preview / code panel */}
				<div className="flex-1 flex flex-col min-h-0 overflow-hidden">
					{/* Right header */}
					<div className="flex-shrink-0 grid grid-cols-3 items-center px-3 py-2 border-b border-border-primary bg-bg-2">
						<div className="flex items-center">
							<div className="flex items-center gap-0.5 bg-bg-1 rounded-md p-0.5">
								<button
									type="button"
									onClick={() => setView('preview')}
									title="Preview"
									className={clsx(
										'p-1 rounded transition-colors',
										view === 'preview'
											? 'bg-bg-4 text-text-primary'
											: 'text-text-50/70 hover:text-text-primary hover:bg-bg-3',
									)}
								>
									<Eye className="size-4" />
								</button>
								<button
									type="button"
									onClick={() => setView('code')}
									title="Code"
									className={clsx(
										'p-1 rounded transition-colors',
										view === 'code'
											? 'bg-bg-4 text-text-primary'
											: 'text-text-50/70 hover:text-text-primary hover:bg-bg-3',
									)}
								>
									<Code className="size-4" />
								</button>
								<button
									type="button"
									onClick={() => setView('stream')}
									title="SSE Stream"
									className={clsx(
										'p-1 rounded transition-colors',
										view === 'stream'
											? 'bg-bg-4 text-text-primary'
											: 'text-text-50/70 hover:text-text-primary hover:bg-bg-3',
									)}
								>
									<Activity className="size-4" />
								</button>
							</div>
						</div>
						<div className="flex items-center justify-center">
							{view === 'code' && selectedFile && (
								<span className="text-sm font-mono text-text-secondary/70 truncate max-w-[200px]">{selectedFile}</span>
							)}
							{view === 'preview' && htmlFile && (
								<span className="text-sm font-mono text-text-secondary/70 truncate max-w-[200px]">{previewEntryPath}</span>
							)}
						</div>
						<div className="flex items-center justify-end gap-1.5">
							{view === 'preview' && htmlFile && (
								<button
									type="button"
									onClick={() => setPreviewKey(k => k + 1)}
									title="Refresh preview"
									className="p-1 hover:bg-bg-3 rounded transition-colors"
								>
									<RefreshCw className="size-4 text-text-primary/50" />
								</button>
							)}
						</div>
					</div>

					{/* Preview view */}
					{view === 'preview' && (
						<div className="flex-1 flex flex-col overflow-hidden bg-[#1d1e1e]">
							{htmlFile ? (
								<iframe
									key={`preview-${previewKey}-${previewEntryPath}`}
									src={`/api/universal/sessions/${sessionId}/preview/${previewEntryPath}`}
									className="flex-1 w-full border-0 bg-white"
									title="Preview"
									sandbox="allow-scripts allow-same-origin"
								/>
							) : sandboxEntries.length === 0 && doneReflect ? (
						<div className="flex-1 overflow-y-auto p-6">
							<div className="max-w-2xl mx-auto">
								{doneReflect.items && doneReflect.items.length > 0 ? (
									<ol className="space-y-3">
										{doneReflect.items.map((item: ReflectItem, i: number) => (
											<li key={i} className="flex flex-col gap-0.5">
												<span className="text-sm text-text-primary font-medium">{item.title}</span>
												<a
													href={item.url}
													target="_blank"
													rel="noopener noreferrer"
													className="text-xs text-blue-400 hover:text-blue-300 break-all"
												>
													{item.url}
												</a>
											</li>
										))}
									</ol>
								) : (
									<p className="text-sm text-text-primary/90 leading-relaxed whitespace-pre-wrap break-words">
										{doneReflect.summary}
									</p>
								)}
							</div>
						</div>
					) : sandboxEntries.length === 0 ? (
								<div className="flex-1 flex flex-col items-center justify-center gap-3 text-gray-500">
									<TerminalSquare className="size-8 text-gray-600" />
									<p className="text-sm font-mono">
										{isRunning ? 'Waiting for output…' : 'No output yet.'}
									</p>
								</div>
							) : (
								<div className="flex-1 overflow-y-auto p-4 space-y-2 font-mono text-sm">
									{sandboxEntries.map((entry, i) => {
										const tool = entry.action.tool;
										const isDirectResponse = tool === 'direct_response';
										const isSandboxRun = tool === 'sandbox_run' || tool === 'shell_exec';
										const isWrite = tool === 'sandbox_write';
										const command = String(entry.action.params.command ?? '');
										const writePath = String(entry.action.params.path ?? entry.action.params.filename ?? '');
										const result = entry.result;
										let stdout = '';
										let stderr = '';
										let exitCode: number | null = null;
										if (result?.output) {
											try {
												const parsed = JSON.parse(result.output) as Record<string, unknown>;
												stdout = String(parsed.stdout ?? '');
												stderr = String(parsed.stderr ?? '');
												exitCode = typeof parsed.exitCode === 'number' ? parsed.exitCode : null;
											} catch {
												stdout = result.output;
											}
										}
										const commandFailed = exitCode !== null && exitCode !== 0;
										return (
											<div key={i} className="space-y-1">
												{isDirectResponse && (
													<div className="text-white/90 whitespace-pre-wrap break-words leading-relaxed border-l-2 border-gray-600 pl-3 py-0.5">
														{String(entry.action.params.content ?? '')}
													</div>
												)}
												{isSandboxRun && (
													<div className="flex items-start gap-2">
														<span className="text-[#f6821f] select-none flex-shrink-0">$</span>
														<span className="text-[#f6821f] break-all">{command}</span>
													</div>
												)}
												{isWrite && (
													<div className="text-blue-400">
														<span className="text-gray-500 select-none mr-2">write</span>
														{writePath}
													</div>
												)}
												{result === null && !isDirectResponse && (
													<div className="flex items-center gap-2 text-gray-500 pl-4">
														<Loader className="size-3 animate-spin" />
														<span>running…</span>
													</div>
												)}
												{stdout && !commandFailed && (
													<pre className="text-green-400 whitespace-pre-wrap break-all leading-relaxed pl-4">{stdout}</pre>
												)}
												{stderr && (
													<pre className="text-red-400 whitespace-pre-wrap break-all leading-relaxed pl-4">{stderr}</pre>
												)}
												{!result?.success && result?.error && (
													<pre className="text-red-400 whitespace-pre-wrap break-all leading-relaxed pl-4">{result.error}</pre>
												)}
											</div>
										);
									})}
								</div>
							)}
						</div>
					)}

					{/* Code view */}
					{view === 'code' && (
						<CodePanel sessionId={sessionId} files={files} onSelectedFileChange={setSelectedFile} />
					)}

					{/* SSE Stream view */}
					{view === 'stream' && (
						<SseStreamPanel events={rawEvents} isRunning={isRunning} />
					)}
				</div>
			</div>
		</div>
	);
}
