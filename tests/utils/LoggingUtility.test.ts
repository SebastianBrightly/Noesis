import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LoggingUtility } from '../../src/utils/LoggingUtility';

describe('LoggingUtility', () => {
	beforeEach(() => {
		// Reset static state
		(LoggingUtility as any).pluginReady = false;
		(LoggingUtility as any).developerLoggingEnabled = false;
		(LoggingUtility as any).fileLogger = null;
		(LoggingUtility as any).fileLoggingEnabled = true;
		vi.restoreAllMocks();
	});

	describe('initialize', () => {
		it('should set pluginReady to true', () => {
			LoggingUtility.initialize();
			expect((LoggingUtility as any).pluginReady).toBe(true);
		});
	});

	describe('setDeveloperLoggingEnabled', () => {
		it('should set developerLoggingEnabled', () => {
			LoggingUtility.setDeveloperLoggingEnabled(true);
			expect((LoggingUtility as any).developerLoggingEnabled).toBe(true);
			LoggingUtility.setDeveloperLoggingEnabled(false);
			expect((LoggingUtility as any).developerLoggingEnabled).toBe(false);
		});
	});

	describe('file logging controls', () => {
		it('should set file logger and file logging enabled flag', () => {
			const sink = vi.fn();
			LoggingUtility.setFileLogger(sink);
			LoggingUtility.setFileLoggingEnabled(false);

			expect((LoggingUtility as any).fileLogger).toBe(sink);
			expect((LoggingUtility as any).fileLoggingEnabled).toBe(false);
		});
	});

	describe('log', () => {
		it('should not log if plugin is not ready', () => {
			const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
			const sink = vi.fn();
			LoggingUtility.setFileLogger(sink);
			LoggingUtility.log('test message');
			expect(spy).not.toHaveBeenCalled();
			expect(sink).not.toHaveBeenCalled();
		});

		it('should not log if developer logging is disabled', () => {
			LoggingUtility.initialize();
			LoggingUtility.setDeveloperLoggingEnabled(false);
			const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
			const sink = vi.fn();
			LoggingUtility.setFileLogger(sink);
			LoggingUtility.log('test message');
			expect(spy).not.toHaveBeenCalled();
			expect(sink).not.toHaveBeenCalled();
		});

		it('should log if plugin is ready and developer logging is enabled', () => {
			LoggingUtility.initialize();
			LoggingUtility.setDeveloperLoggingEnabled(true);
			const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
			const sink = vi.fn();
			LoggingUtility.setFileLogger(sink);
			LoggingUtility.log('test message', { data: 123 });
			expect(spy).toHaveBeenCalledWith('test message', { data: 123 });
			expect(sink).toHaveBeenCalledTimes(1);
			expect(sink.mock.calls[0][0]).toContain('[INFO]');
			expect(sink.mock.calls[0][0]).toContain('test message');
		});
	});

	describe('warn', () => {
		it('should not warn if plugin is not ready', () => {
			const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const sink = vi.fn();
			LoggingUtility.setFileLogger(sink);
			LoggingUtility.warn('test warning');
			expect(spy).not.toHaveBeenCalled();
			expect(sink).not.toHaveBeenCalled();
		});

		it('should not warn if developer logging is disabled', () => {
			LoggingUtility.initialize();
			LoggingUtility.setDeveloperLoggingEnabled(false);
			const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const sink = vi.fn();
			LoggingUtility.setFileLogger(sink);
			LoggingUtility.warn('test warning');
			expect(spy).not.toHaveBeenCalled();
			expect(sink).not.toHaveBeenCalled();
		});

		it('should warn if plugin is ready and developer logging is enabled', () => {
			LoggingUtility.initialize();
			LoggingUtility.setDeveloperLoggingEnabled(true);
			const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const sink = vi.fn();
			LoggingUtility.setFileLogger(sink);
			LoggingUtility.warn('test warning', { data: 123 });
			expect(spy).toHaveBeenCalledWith('test warning', { data: 123 });
			expect(sink).toHaveBeenCalledTimes(1);
			expect(sink.mock.calls[0][0]).toContain('[WARN]');
		});
	});

	describe('error', () => {
		it('should always error regardless of settings (plugin not ready)', () => {
			const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const sink = vi.fn();
			LoggingUtility.setFileLogger(sink);
			LoggingUtility.error('test error');
			expect(spy).toHaveBeenCalledWith('test error');
			expect(sink).toHaveBeenCalledTimes(1);
			expect(sink.mock.calls[0][0]).toContain('[ERROR]');
		});

		it('should always error regardless of settings (plugin ready, logging disabled)', () => {
			LoggingUtility.initialize();
			LoggingUtility.setDeveloperLoggingEnabled(false);
			const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const sink = vi.fn();
			LoggingUtility.setFileLogger(sink);
			LoggingUtility.error('test error');
			expect(spy).toHaveBeenCalledWith('test error');
			expect(sink).toHaveBeenCalledTimes(1);
		});

		it('should always error regardless of settings (plugin ready, logging enabled)', () => {
			LoggingUtility.initialize();
			LoggingUtility.setDeveloperLoggingEnabled(true);
			const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const sink = vi.fn();
			LoggingUtility.setFileLogger(sink);
			LoggingUtility.error('test error', { data: 123 });
			expect(spy).toHaveBeenCalledWith('test error', { data: 123 });
			expect(sink).toHaveBeenCalledTimes(1);
		});

		it('should skip file logging when file logging is disabled', () => {
			const sink = vi.fn();
			LoggingUtility.setFileLogger(sink);
			LoggingUtility.setFileLoggingEnabled(false);
			LoggingUtility.error('test error');
			expect(sink).not.toHaveBeenCalled();
		});
	});
});
