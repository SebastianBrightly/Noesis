/**
 * Converts an unknown/any-typed value (e.g. from a catch block or DOM error event)
 * into a safely-typed value suitable for logging or assignment, avoiding
 * no-unsafe-assignment violations downstream.
 */
export function toSafeLogValue(value: unknown): string | Record<string, unknown> {
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack
		};
	}
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (value === null || value === undefined) {
		return String(value);
	}
	// Fallback for objects, symbols, etc. — avoid unsafe assignment by stringifying
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}