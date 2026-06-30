export class LoggingUtility {
	private static pluginReady: boolean = false;
	private static developerLoggingEnabled: boolean = false;
	private static fileLogger: ((line: string) => void | Promise<void>) | null = null;
	private static fileLoggingEnabled: boolean = true;

	static initialize() {
		LoggingUtility.pluginReady = true;
	}

	static setFileLogger(logger: ((line: string) => void | Promise<void>) | null) {
		LoggingUtility.fileLogger = logger;
	}

	static setFileLoggingEnabled(enabled: boolean) {
		LoggingUtility.fileLoggingEnabled = enabled;
	}

	static setDeveloperLoggingEnabled(enabled: boolean) {
		LoggingUtility.developerLoggingEnabled = enabled;
	}

	static log(...args: unknown[]) {
		// If plugin is not initialized, default to logging (for early initialization/unload)
		// Or if settings are not yet loaded, or if developer logging is enabled
		if (LoggingUtility.isDeveloperLoggingEnabled()) {
			console.log(...args);
			LoggingUtility.writeToFile('INFO', args);
		}
	}

	static warn(...args: unknown[]) {
		// If plugin is not initialized, default to logging (for early initialization/unload)
		// Or if settings are not yet loaded, or if developer logging is enabled
		if (LoggingUtility.isDeveloperLoggingEnabled()) {
			console.warn(...args);
			LoggingUtility.writeToFile('WARN', args);
		}
	}

	static error(...args: unknown[]) {
		// Always log errors regardless of developer logging setting or plugin initialization
		console.error(...args);
		LoggingUtility.writeToFile('ERROR', args);
	}

	private static isDeveloperLoggingEnabled(): boolean {
		if (!LoggingUtility.pluginReady) {
			return false;
		}

		return LoggingUtility.developerLoggingEnabled;
	}

	private static writeToFile(level: 'INFO' | 'WARN' | 'ERROR', args: unknown[]) {
		if (!LoggingUtility.fileLoggingEnabled || !LoggingUtility.fileLogger) {
			return;
		}

		const serialized = args.map((arg) => LoggingUtility.serializeArg(arg)).join(' ');
		const line = `[${new Date().toISOString()}] [${level}] ${serialized}`;

		try {
			const result = LoggingUtility.fileLogger(line);
			if (result instanceof Promise) {
				result.catch(() => {
					// Never throw from logger internals.
				});
			}
		} catch (_error) {
			// Never throw from logger internals.
		}
	}

	private static serializeArg(arg: unknown): string {
		if (arg instanceof Error) {
			return arg.stack ?? `${arg.name}: ${arg.message}`;
		}

		if (typeof arg === 'string') {
			return arg;
		}

		try {
			return JSON.stringify(arg);
		} catch (_error) {
			return String(arg);
		}
	}
} 
