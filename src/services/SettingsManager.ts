import { Plugin } from 'obsidian';
import { LoggingUtility } from '../utils/LoggingUtility';
import { ContextMode } from '../main';
import { LocalLLMSettings } from '@/main';
import { DEFAULT_SETTINGS } from '@/main';

export const SM_DEFAULT_SETTINGS = { ...DEFAULT_SETTINGS };


export class SettingsManager {
	private static instance: SettingsManager;
	private plugin: Plugin;
	private settings: LocalLLMSettings;
	private settingsChangeCallbacks: (() => void)[] = [];

	private constructor(plugin: Plugin) {
		this.plugin = plugin;
		this.settings = { ...DEFAULT_SETTINGS };
	}

	public static initialize(plugin: Plugin): SettingsManager {
		if (!SettingsManager.instance) {
			SettingsManager.instance = new SettingsManager(plugin);
		}
		return SettingsManager.instance;
	}

	public static getInstance(): SettingsManager {
		if (!SettingsManager.instance) {
			throw new Error('SettingsManager must be initialized before use');
		}
		return SettingsManager.instance;
	}

	public async loadSettings(): Promise<void> {
		try {
			const loadedData = await this.plugin.loadData();
			this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
			// Ensure new scaffold fields have expected types (migration)
			if (typeof this.settings.enableShortResponses !== 'boolean') {
				this.settings.enableShortResponses = DEFAULT_SETTINGS.enableShortResponses;
			}
			if (typeof this.settings.selectedPersonality !== 'string' && typeof this.settings.selectedPersonality !== 'undefined') {
				this.settings.selectedPersonality = DEFAULT_SETTINGS.selectedPersonality;
			}
			if (typeof this.settings.augmentSystemPromptwithPersonality !== 'boolean') {
				this.settings.augmentSystemPromptwithPersonality = DEFAULT_SETTINGS.augmentSystemPromptwithPersonality;
			}
			if (typeof this.settings.graphRerankAdvancedExpanded !== 'boolean') {
				this.settings.graphRerankAdvancedExpanded = DEFAULT_SETTINGS.graphRerankAdvancedExpanded;
			}
			if (!Array.isArray(this.settings.personalityPrompt)) {
				this.settings.personalityPrompt = DEFAULT_SETTINGS.personalityPrompt;
			}
			// Ensure personalityNames is an array (migrate from older string or other formats)
			if (!Array.isArray(this.settings.personalityNames)) {
				if (typeof (this.settings as any).personalityNames === 'string') {
					this.settings.personalityNames = (this.settings as any).personalityNames
						.split('\n')
						.map((s: string) => s.trim())
						.filter((s: string) => s.length > 0);
				} else {
					this.settings.personalityNames = DEFAULT_SETTINGS.personalityNames;
				}
			}
			if (!Array.isArray(this.settings.storedPersonalitySystemPrompt)) {
				this.settings.storedPersonalitySystemPrompt = DEFAULT_SETTINGS.storedPersonalitySystemPrompt;
			}
			LoggingUtility.log('Settings loaded:', this.settings);
		} catch (error) {
			LoggingUtility.error('Failed to load settings:', error);
			this.settings = { ...DEFAULT_SETTINGS };
		}
	}

	public async saveSettings(): Promise<void> {
		try {
			await this.plugin.saveData(this.settings);
			LoggingUtility.log('Settings saved:', this.settings);
			this.notifySettingsChange();
		} catch (error) {
			LoggingUtility.error('Failed to save settings:', error);
		}
	}

	public getSettings(): LocalLLMSettings {
		return { ...this.settings };
	}

	public getSetting<K extends keyof LocalLLMSettings>(key: K): LocalLLMSettings[K] {
		return this.settings[key];
	}

	public async setSetting<K extends keyof LocalLLMSettings>(key: K, value: LocalLLMSettings[K]): Promise<void> {
		this.settings[key] = value;
		await this.saveSettings();
	}

	public async updateSettings(updates: Partial<LocalLLMSettings>): Promise<void> {
		Object.assign(this.settings, updates);
		await this.saveSettings();
	}

	public onSettingsChange(callback: () => void): void {
		this.settingsChangeCallbacks.push(callback);
	}

	public removeSettingsChangeCallback(callback: () => void): void {
		const index = this.settingsChangeCallbacks.indexOf(callback);
		if (index !== -1) {
			this.settingsChangeCallbacks.splice(index, 1);
		}
	}

	private notifySettingsChange(): void {
		this.settingsChangeCallbacks.forEach(callback => {
			try {
				callback();
			} catch (error) {
				LoggingUtility.error('Error in settings change callback:', error);
			}
		});
	}

	public static async cleanup(): Promise<void> {
		if (SettingsManager.instance) {
			SettingsManager.instance.settingsChangeCallbacks = [];
			SettingsManager.instance = undefined as any;
		}
	}
} 
