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
	File,
	Rocket,
	TerminalSquare,
	RefreshCw,
} from 'lucide-react';
import clsx from 'clsx';
import type {
	ThinkingEventData,
	PlanEventData,
	ActionEventData,
	ToolResultEventData,
	ReflectEventData,
	DoneEventData,
	ErrorEventData,
	StatusEventData,
	FileEventData,
	DeployReadyEventData,
	SessionFileEntry,
} from '@/api-types';
import { apiClient } from '@/lib/api-client';

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
	});

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
						setState(s => applyEvent(s, eventType, data));
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

export default function AgentPage() {
	const { sessionId } = useParams<{ sessionId: string }>();
	const location = useLocation();
	const navigate = useNavigate();
	const instruction = (location.state as { instruction?: string } | null)?.instruction ?? '';

	const chatRef = useRef<HTMLDivElement>(null);

	const { agentStatus, statusMessage, thinkingText, plan, actionLog, reflections, files, deployReady, error } =
		useAgentStream(sessionId ?? '');

	const [view, setView] = useState<'preview' | 'code'>('preview');
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [fileContent, setFileContent] = useState<string | null>(null);
	const [loadingFile, setLoadingFile] = useState(false);
	const [deploying, setDeploying] = useState(false);
	const [previewKey, setPreviewKey] = useState(0);

	const handleDeploy = async () => {
		if (!sessionId || deploying) return;
		setDeploying(true);
		const result = await apiClient.deployAgentSession(sessionId, instruction);
		setDeploying(false);
		if (result.data?.previewUrl) window.open(result.data.previewUrl, '_blank');
	};

	const handleFileClick = async (filePath: string) => {
		if (!sessionId) return;
		setSelectedFile(filePath);
		setFileContent(null);
		setLoadingFile(true);
		setView('code');
		const result = await apiClient.getSessionFileContent(sessionId, filePath);
		setFileContent(result.data?.content ?? '// Error loading file');
		setLoadingFile(false);
	};

	const htmlFile = files.find(f => f.path.endsWith('.html'));
	const previewEntryPath = htmlFile?.path.replace(/^\/+/, '') ?? 'index.html';
	const sandboxEntries = actionLog.filter(e =>
		['sandbox_write', 'sandbox_run', 'shell_exec', 'sandbox_read'].includes(e.action.tool),
	);
	const hasSandboxResult = sandboxEntries.some(e => e.result !== null);
	const isRunning = agentStatus === 'connecting' || agentStatus === 'running';

	const hasHtmlFile = !!htmlFile;
	const autoSwitched = useRef(false);
	useEffect(() => {
		if ((hasHtmlFile || hasSandboxResult) && !autoSwitched.current) {
			autoSwitched.current = true;
			setView('preview');
		}
	}, [hasHtmlFile, hasSandboxResult]);

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
										const isSandboxRun = entry.action.tool === 'sandbox_run' || entry.action.tool === 'shell_exec';
										const isWrite = entry.action.tool === 'sandbox_write';
										const command = String(entry.action.params.command ?? '');
										const writePath = String(entry.action.params.path ?? entry.action.params.filename ?? '');
										const result = entry.result;
										let prettyOutput = '';
										if (result?.output) {
											try { prettyOutput = JSON.stringify(JSON.parse(result.output), null, 2); }
											catch { prettyOutput = result.output; }
										}
										return (
											<div key={i} className="space-y-1">
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
												{result === null && (
													<div className="flex items-center gap-2 text-gray-500 pl-4">
														<Loader className="size-3 animate-spin" />
														<span>running…</span>
													</div>
												)}
												{result?.success && prettyOutput && (
													<pre className="text-green-400 whitespace-pre-wrap break-all leading-relaxed pl-4">
														{prettyOutput}
													</pre>
												)}
												{!result?.success && result?.error && (
													<pre className="text-red-400 whitespace-pre-wrap break-all leading-relaxed pl-4">
														{result.error}
													</pre>
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
						<div className="flex-1 flex overflow-hidden min-h-0">
							<div className="w-48 flex-shrink-0 border-r border-border-primary/30 overflow-y-auto p-1 bg-bg-1">
								{files.length === 0 ? (
									<p className="text-xs text-text-tertiary italic p-3">No files yet…</p>
								) : (
									files.map(file => (
										<button
											key={file.path}
											type="button"
											onClick={() => void handleFileClick(file.path)}
											className={clsx(
												'w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-xs text-left transition-colors',
												selectedFile === file.path
													? 'bg-accent/10 text-accent'
													: 'text-text-secondary hover:bg-bg-3/50 hover:text-text-primary',
											)}
										>
											<File className="size-3 flex-shrink-0" />
											<span className="truncate">{file.path}</span>
										</button>
									))
								)}
							</div>
							<div className="flex-1 overflow-auto bg-bg-1">
								{!selectedFile ? (
									<p className="text-xs text-text-tertiary italic p-4">Select a file to view</p>
								) : loadingFile ? (
									<div className="flex items-center gap-2 p-4 text-text-tertiary">
										<Loader className="size-3 animate-spin" />
										<span className="text-xs">Loading…</span>
									</div>
								) : (
									<pre className="p-4 text-xs font-mono text-text-primary whitespace-pre-wrap break-words leading-relaxed">
										{fileContent ?? ''}
									</pre>
								)}
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
