export interface AgentTaskPayload {
	taskId: string;
	sessionId: string;
	userId: string;
	instruction: string;
	timestamp: number;
}

export type SseEventType =
	| 'thinking'
	| 'plan'
	| 'action'
	| 'result'
	| 'reflect'
	| 'file'
	| 'text'
	| 'status'
	| 'done'
	| 'deploy_ready'
	| 'error';

export interface ThinkingEventData {
	content: string;
}

export interface TaskStep {
	index: number;
	description: string;
	tool: string;
	params: Record<string, string | number | boolean>;
}

export interface PlanEventData {
	steps: TaskStep[];
	summary: string;
}

export interface ActionEventData {
	step: number;
	tool: string;
	params: Record<string, string | number | boolean>;
}

export interface TextEventData {
	content: string;
}

export interface StatusEventData {
	message: string;
}

export interface DoneEventData {
	taskId: string;
}

export interface ErrorEventData {
	message: string;
	code?: string;
}

export interface ToolResultEventData {
	step: number;
	tool: string;
	success: boolean;
	output: string;
	error?: string;
}

export interface ReflectEventData {
	isDone: boolean;
	summary: string;
	iteration: number;
}

export interface FileEventData {
	path: string;
	size: number;
}

export interface DeployReadyEventData {
	sessionId: string;
	fileCount: number;
}

export interface ConversationTurn {
	plan: PlanEventData;
	results: ToolResultEventData[];
}
