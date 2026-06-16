export const MAX_OUTPUT_BYTES = 50_000;

export function truncate(s: string, max = MAX_OUTPUT_BYTES): string {
	return s.length > max ? s.slice(0, max) + `\n… (truncated, ${s.length - max} more bytes)` : s;
}

export function str(v: unknown): string {
	return typeof v === 'string' ? v : String(v ?? '');
}
