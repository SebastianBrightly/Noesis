export function defaultAsyncHandlerError(err: unknown): void {
	console.error('[AsyncHandler]', err);
}

/**
 * Wrap an async callback so it can be safely passed to APIs expecting a void callback.
 */
export function voidAsync<TArgs extends unknown[]>(
	fn: (...args: TArgs) => Promise<void>,
	onError: (err: unknown) => void = defaultAsyncHandlerError
): (...args: TArgs) => void {
	return (...args: TArgs): void => {
		void fn(...args).catch(onError);
	};
}
