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
	| 'text'
	| 'status'
	| 'done'
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
