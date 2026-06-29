import { Plugin } from 'obsidian';
import { LoggingUtility } from '../utils/LoggingUtility';
import { ContextMode } from '../main';
import { LocalLLMSettings } from '@/main';
import { DEFAULT_SETTINGS } from '@/main';

export const SM_DEFAULT_SETTINGS = { ...DEFAULT_SETTINGS };


export class SettingsManager {
	private static instance?: SettingsManager;
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
			const loadedData: unknown = await this.plugin.loadData();
			const normalizedLoadedData = (loadedData && typeof loadedData === 'object') ? loadedData : {};
			this.settings = Object.assign({}, DEFAULT_SETTINGS, normalizedLoadedData);
			const validContextModes: ContextMode[] = [
				ContextMode.CURRENT_NOTE,
				ContextMode.LINKED_NOTES,
				ContextMode.CURRENT_FOLDER,
				ContextMode.DAILY_NOTES,
				ContextMode.BOOKMARKED_NOTES,
				ContextMode.SEARCH_QUERY_SCOPE,
				ContextMode.OPEN_NOTES,
				ContextMode.SEARCH,
				ContextMode.NONE
			];
			const normalizeConnectionConfig = (raw: unknown) => {
				if (!raw || typeof raw !== 'object') {
					return null;
				}

				const rawConfig = raw as Record<string, unknown>;

				return {
					id: typeof rawConfig.id === 'string' && rawConfig.id.trim().length > 0
						? rawConfig.id.trim()
						: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					name: typeof rawConfig.name === 'string' && rawConfig.name.trim().length > 0
						? rawConfig.name.trim()
						: 'External Connection',
					isSleeping: Boolean(rawConfig.isSleeping),
					contextMode: validContextModes.includes(rawConfig.contextMode as ContextMode)
						? rawConfig.contextMode as ContextMode
						: this.settings.contextMode,
					apiEndpoint: typeof rawConfig.apiEndpoint === 'string' && rawConfig.apiEndpoint.trim().length > 0
						? rawConfig.apiEndpoint.trim()
						: this.settings.apiEndpoint,
					apiKey: typeof rawConfig.apiKey === 'string' && rawConfig.apiKey.trim().length > 0
						? rawConfig.apiKey.trim()
						: undefined,
					model: typeof rawConfig.model === 'string' && rawConfig.model.trim().length > 0
						? rawConfig.model.trim()
						: undefined,
					maxTokens: Number.isFinite(rawConfig.maxTokens)
						? Number(rawConfig.maxTokens)
						: this.settings.maxTokens,
					temperature: Number.isFinite(rawConfig.temperature)
						? Number(rawConfig.temperature)
						: this.settings.temperature
				};
			};
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
				const rawPersonalityNames = (this.settings as unknown as Record<string, unknown>).personalityNames;
				if (typeof rawPersonalityNames === 'string') {
					this.settings.personalityNames = rawPersonalityNames
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
			const rawConnections = (this.settings as unknown as Record<string, unknown>).multiAIConnections;
			if (!Array.isArray(rawConnections)) {
				this.settings.multiAIConnections = DEFAULT_SETTINGS.multiAIConnections;
			} else {
				this.settings.multiAIConnections = rawConnections
					.map((entry: unknown) => normalizeConnectionConfig(entry))
					.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
			}

			if (typeof this.settings.activeAIConnectionId !== 'string' || this.settings.activeAIConnectionId.trim().length === 0) {
				this.settings.activeAIConnectionId = DEFAULT_SETTINGS.activeAIConnectionId;
			}

			if (this.settings.activeAIConnectionId && !(this.settings.multiAIConnections || []).some(conn => conn.id === this.settings.activeAIConnectionId)) {
				this.settings.activeAIConnectionId = DEFAULT_SETTINGS.activeAIConnectionId;
			}

			if (typeof this.settings.autoTagConnectionId !== 'string' || this.settings.autoTagConnectionId.trim().length === 0) {
				this.settings.autoTagConnectionId = DEFAULT_SETTINGS.autoTagConnectionId;
			}

			if (this.settings.autoTagConnectionId && !(this.settings.multiAIConnections || []).some(conn => conn.id === this.settings.autoTagConnectionId && !conn.isSleeping)) {
				this.settings.autoTagConnectionId = DEFAULT_SETTINGS.autoTagConnectionId;
			}

			// Migrate legacy graph reranking defaults to semantics-first additive defaults.
			// Only adjust when values exactly match the previous default profile.
			const usesLegacyGraphDefaults =
				this.settings.graphWeightSemantic === 0.7 &&
				this.settings.graphWeightBacklinkDistance === 0.12 &&
				this.settings.graphWeightRecency === 0.08 &&
				this.settings.graphWeightBookmarked === 0.06 &&
				this.settings.graphWeightFolderProximity === 0.04 &&
				this.settings.graphRecencyHalfLifeDays === 14;

			if (usesLegacyGraphDefaults) {
				this.settings.graphWeightSemantic = DEFAULT_SETTINGS.graphWeightSemantic;
				this.settings.graphWeightBacklinkDistance = DEFAULT_SETTINGS.graphWeightBacklinkDistance;
				this.settings.graphWeightRecency = DEFAULT_SETTINGS.graphWeightRecency;
				this.settings.graphWeightBookmarked = DEFAULT_SETTINGS.graphWeightBookmarked;
				this.settings.graphWeightFolderProximity = DEFAULT_SETTINGS.graphWeightFolderProximity;
				this.settings.graphRecencyHalfLifeDays = DEFAULT_SETTINGS.graphRecencyHalfLifeDays;
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
			SettingsManager.instance = undefined;
		}
	}
} 
