import { useEffect, useRef, useState } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router';
import { ArrowLeft, CheckCircle, XCircle, Loader, ChevronDown, ChevronRight, File } from 'lucide-react';
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

function StatusBadge({ status, message }: { status: AgentStatus; message: string }) {
	const map: Record<AgentStatus, { cls: string; spinner: boolean; check: boolean; cross: boolean }> = {
		connecting: { cls: 'bg-text-primary/10 text-text-secondary', spinner: true, check: false, cross: false },
		running:    { cls: 'bg-accent/10 text-accent',               spinner: true, check: false, cross: false },
		done:       { cls: 'bg-green-500/10 text-green-500',         spinner: false, check: true,  cross: false },
		error:      { cls: 'bg-red-500/10 text-red-500',             spinner: false, check: false, cross: true  },
	};
	const { cls, spinner, check, cross } = map[status];
	return (
		<span className={clsx('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium', cls)}>
			{spinner && <Loader className="size-3 animate-spin" />}
			{check   && <CheckCircle className="size-3" />}
			{cross   && <XCircle className="size-3" />}
			{message}
		</span>
	);
}

function ThinkingBlock({ text }: { text: string }) {
	return (
		<div className="rounded-xl border border-border-primary/30 bg-bg-4 dark:bg-bg-2 px-4 py-3">
			<div className="flex items-center gap-2 mb-2">
				<Loader className="size-3 text-text-tertiary animate-spin" />
				<span className="text-xs font-medium text-text-tertiary uppercase tracking-wider">Thinking</span>
			</div>
			<p className="text-xs font-mono text-text-secondary/70 italic leading-relaxed whitespace-pre-wrap break-words">
				{clampText(text, 900)}
			</p>
		</div>
	);
}

function PlanBlock({ plan }: { plan: PlanEventData }) {
	return (
		<div className="rounded-xl border border-accent/20 bg-bg-4 dark:bg-bg-2 px-4 py-3">
			<div className="flex items-center gap-2 mb-2">
				<div className="size-2 rounded-full bg-accent" />
				<span className="text-xs font-medium text-text-secondary uppercase tracking-wider">Plan</span>
				<span className="ml-auto text-xs text-text-tertiary">{plan.steps.length} steps</span>
			</div>
			<p className="text-sm text-text-primary mb-3 leading-snug">{plan.summary}</p>
			<div className="space-y-1.5">
				{plan.steps.map(step => (
					<div key={step.index} className="flex items-start gap-2">
						<span className="flex-shrink-0 text-xs text-text-tertiary font-mono w-4 leading-5">{step.index}.</span>
						<code className="flex-shrink-0 text-xs text-accent font-mono leading-5">{step.tool}</code>
						<span className="text-xs text-text-secondary leading-5 truncate">{step.description}</span>
					</div>
				))}
			</div>
		</div>
	);
}

function ReflectBlock({ reflection }: { reflection: ReflectEventData }) {
	return (
		<div className={clsx(
			'rounded-xl border px-4 py-3',
			reflection.isDone
				? 'border-green-500/20 bg-green-500/5'
				: 'border-border-primary/30 bg-bg-4 dark:bg-bg-2',
		)}>
			<div className="flex items-center gap-2 mb-1.5">
				<CheckCircle className={clsx('size-3', reflection.isDone ? 'text-green-500' : 'text-text-tertiary')} />
				<span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
					Reflect · iteration {reflection.iteration + 1}
				</span>
				{reflection.isDone && <span className="ml-auto text-xs text-green-500 font-medium">Done</span>}
			</div>
			<p className="text-sm text-text-primary leading-snug">{reflection.summary}</p>
		</div>
	);
}

function ActionLogEntry({ entry }: { entry: ActionEntry }) {
	const [expanded, setExpanded] = useState(false);
	const { action, result } = entry;
	const pending = result === null;

	return (
		<div className="rounded-lg border border-border-primary/30 overflow-hidden">
			<button
				type="button"
				onClick={() => setExpanded(e => !e)}
				className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-bg-3/30 transition-colors"
			>
				{pending ? (
					<Loader className="size-3.5 flex-shrink-0 text-accent animate-spin" />
				) : result!.success ? (
					<CheckCircle className="size-3.5 flex-shrink-0 text-green-500" />
				) : (
					<XCircle className="size-3.5 flex-shrink-0 text-red-500" />
				)}
				<span className="text-xs text-text-tertiary font-mono flex-shrink-0">Step {action.step}</span>
				<code className="text-xs font-mono text-accent flex-shrink-0">{action.tool}</code>
				{!pending && !result!.success && (
					<span className="text-xs text-red-400 truncate flex-1">failed</span>
				)}
				<span className="ml-auto flex-shrink-0">
					{expanded
						? <ChevronDown className="size-3 text-text-tertiary" />
						: <ChevronRight className="size-3 text-text-tertiary" />}
				</span>
			</button>

			{expanded && (
				<div className="border-t border-border-primary/30 px-3 py-2.5 bg-bg-1/50 space-y-2.5">
					<div>
						<p className="text-xs text-text-tertiary mb-1">params</p>
						<pre className="text-xs font-mono text-text-secondary whitespace-pre-wrap break-all leading-relaxed">
							{JSON.stringify(action.params, null, 2)}
						</pre>
					</div>
					{!pending && (
						<div>
							<p className="text-xs text-text-tertiary mb-1">{result!.success ? 'output' : 'error'}</p>
							<pre className={clsx(
								'text-xs font-mono whitespace-pre-wrap break-all leading-relaxed',
								result!.success ? 'text-text-secondary' : 'text-red-400',
							)}>
								{clampText(result!.output || result!.error || '', 800)}
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

	const leftRef  = useRef<HTMLDivElement>(null);
	const rightRef = useRef<HTMLDivElement>(null);

	const { agentStatus, statusMessage, thinkingText, plan, actionLog, reflections, files, error } =
		useAgentStream(sessionId ?? '');

	const [rightTab, setRightTab] = useState<'log' | 'files'>('log');
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [fileContent, setFileContent] = useState<string | null>(null);
	const [loadingFile, setLoadingFile] = useState(false);

	const handleFileClick = async (filePath: string) => {
		if (!sessionId) return;
		setSelectedFile(filePath);
		setFileContent(null);
		setLoadingFile(true);
		const result = await apiClient.getSessionFileContent(sessionId, filePath);
		setFileContent(result.data?.content ?? '// Error loading file');
		setLoadingFile(false);
	};

	useEffect(() => {
		leftRef.current?.scrollTo({ top: leftRef.current.scrollHeight, behavior: 'smooth' });
	}, [thinkingText, plan, reflections.length]);

	useEffect(() => {
		rightRef.current?.scrollTo({ top: rightRef.current.scrollHeight, behavior: 'smooth' });
	}, [actionLog.length]);

	if (!sessionId) {
		return <div className="p-8 text-text-secondary text-sm">Invalid session.</div>;
	}

	return (
		<div className="flex flex-col h-full overflow-hidden bg-bg-1 dark:bg-bg-1">
			{/* Header */}
			<div className="flex-shrink-0 flex items-center gap-3 px-4 py-3 border-b border-border-primary bg-bg-4 dark:bg-bg-2">
				<button
					type="button"
					onClick={() => navigate('/')}
					className="flex items-center gap-1.5 text-text-tertiary hover:text-text-primary transition-colors p-1 rounded"
					aria-label="Back to home"
				>
					<ArrowLeft className="size-4" />
				</button>
				<div className="flex-1 min-w-0">
					<p className="text-xs text-text-tertiary leading-none mb-0.5">Universal Agent</p>
					{instruction ? (
						<p className="text-sm font-medium text-text-primary truncate leading-tight">{instruction}</p>
					) : (
						<p className="text-sm text-text-tertiary leading-tight">Session {sessionId.slice(0, 8)}…</p>
					)}
				</div>
				<StatusBadge status={agentStatus} message={error ?? statusMessage} />
			</div>

			{/* Split panels */}
			<div className="flex-1 flex overflow-hidden min-h-0">
				{/* Left: Brain activity */}
				<div className="w-2/5 border-r border-border-primary flex flex-col overflow-hidden">
					<div className="flex-shrink-0 px-4 py-2 border-b border-border-primary/50 bg-bg-4/50 dark:bg-bg-2/50">
						<span className="text-xs font-medium text-text-tertiary uppercase tracking-wider">Brain Activity</span>
					</div>
					<div ref={leftRef} className="flex-1 overflow-y-auto p-4 space-y-3">
						{agentStatus === 'connecting' && (
							<div className="flex items-center gap-2 text-text-tertiary pt-2">
								<Loader className="size-4 animate-spin" />
								<span className="text-sm">Connecting to agent session…</span>
							</div>
						)}

						{thinkingText && <ThinkingBlock text={thinkingText} />}
						{plan && <PlanBlock plan={plan} />}
						{reflections.map((r, i) => (
							<ReflectBlock key={i} reflection={r} />
						))}

						{agentStatus === 'done' && (
							<div className="rounded-xl border border-green-500/30 bg-green-500/5 px-4 py-4 text-center">
								<CheckCircle className="size-5 text-green-500 mx-auto mb-1.5" />
								<p className="text-sm font-medium text-green-500">Task Complete</p>
							</div>
						)}
						{agentStatus === 'error' && (
							<div className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3">
								<div className="flex items-center gap-2 mb-1">
									<XCircle className="size-4 text-red-500" />
									<span className="text-xs font-medium text-red-400 uppercase tracking-wider">Error</span>
								</div>
								<p className="text-sm text-red-400">{error}</p>
							</div>
						)}
					</div>
				</div>

				{/* Right: tabbed (Log / Files) */}
				<div className="flex-1 flex flex-col overflow-hidden">
					{/* Tab bar */}
					<div className="flex-shrink-0 flex items-center border-b border-border-primary/50 bg-bg-4/50 dark:bg-bg-2/50">
						{(['log', 'files'] as const).map(tab => (
							<button
								key={tab}
								type="button"
								onClick={() => setRightTab(tab)}
								className={clsx(
									'px-4 py-2 text-xs font-medium uppercase tracking-wider border-b-2 transition-colors',
									rightTab === tab
										? 'border-accent text-accent'
										: 'border-transparent text-text-tertiary hover:text-text-primary',
								)}
							>
								{tab === 'log' ? 'Execution Log' : `Files (${files.length})`}
							</button>
						))}
					</div>

					{rightTab === 'log' ? (
						<div ref={rightRef} className="flex-1 overflow-y-auto p-4 space-y-2">
							{actionLog.length === 0 ? (
								<p className="text-sm text-text-tertiary italic pt-2">
									{agentStatus === 'connecting' || agentStatus === 'running'
										? 'Waiting for tool actions…'
										: 'No actions executed.'}
								</p>
							) : (
								actionLog.map((entry, i) => <ActionLogEntry key={i} entry={entry} />)
							)}
						</div>
					) : (
						<div className="flex-1 flex overflow-hidden min-h-0">
							{/* File tree */}
							<div className="w-48 flex-shrink-0 border-r border-border-primary/30 overflow-y-auto p-1">
								{files.length === 0 ? (
									<p className="text-xs text-text-tertiary italic p-3">No files yet…</p>
								) : (
									files.map(file => (
										<button
											key={file.path}
											type="button"
											onClick={() => handleFileClick(file.path)}
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
							{/* Code preview */}
							<div className="flex-1 overflow-auto bg-bg-1 dark:bg-bg-1">
								{!selectedFile ? (
									<p className="text-xs text-text-tertiary italic p-4">Select a file to preview</p>
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
