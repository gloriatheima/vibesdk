import { DurableObject } from 'cloudflare:workers';
import type { ToolServerEnv } from './env';

const POOL_SIZE = 5;
const SLOT_TTL_MS = 30 * 60 * 1000;

interface SlotState {
	sessionId: string | null;
	acquiredAt: number | null;
}

export interface AcquireResult {
	slotId: string;
	needsCleanup: boolean;
}

export class SandboxPool extends DurableObject<ToolServerEnv> {
	async acquire(sessionId: string): Promise<AcquireResult | null> {
		const now = Date.now();
		const slots = await this.getSlots();

		for (const [id, s] of Object.entries(slots)) {
			if (s.sessionId === sessionId) {
				return { slotId: id, needsCleanup: false };
			}
		}

		const entry = Object.entries(slots).find(
			([, s]) =>
				s.sessionId === null ||
				(s.acquiredAt !== null && now - s.acquiredAt > SLOT_TTL_MS),
		);
		if (!entry) return null;

		const [slotId, prev] = entry;
		const needsCleanup = prev.sessionId !== null;
		slots[slotId] = { sessionId, acquiredAt: now };
		await this.ctx.storage.put('slots', slots);
		return { slotId, needsCleanup };
	}

	async release(sessionId: string): Promise<void> {
		const slots = await this.getSlots();
		let changed = false;
		for (const slotId of Object.keys(slots)) {
			if (slots[slotId].sessionId === sessionId) {
				slots[slotId] = { sessionId: null, acquiredAt: null };
				changed = true;
			}
		}
		if (changed) await this.ctx.storage.put('slots', slots);
	}

	async getAllSlotIds(): Promise<string[]> {
		return Array.from({ length: POOL_SIZE }, (_, i) => `sandbox-pool-${i}`);
	}

	private async getSlots(): Promise<Record<string, SlotState>> {
		const stored = await this.ctx.storage.get<Record<string, SlotState>>('slots');
		if (stored) return stored;
		const slots: Record<string, SlotState> = {};
		for (let i = 0; i < POOL_SIZE; i++) {
			slots[`sandbox-pool-${i}`] = { sessionId: null, acquiredAt: null };
		}
		return slots;
	}
}
