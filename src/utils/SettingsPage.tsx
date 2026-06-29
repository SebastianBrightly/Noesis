import LocalLLMPlugin from "@/main";
import  { ContextMode, PersonalityMode,PersonalityTrait, CHAT_VIEW_TYPE, AIConnectionConfig, LocalLLMSettings } from "@/main";
import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, ItemView, Notice, DropdownComponent  } from "obsidian";
import React from "react";
import { Tab, Tabs, TabList, TabPanel } from 'react-tabs';
import { createPluginRoot } from "@/ReactView";
import { ChatView } from '@/views/ChatView';
import { FirstRunWizardModal } from '@/views/FirstRunWizard';
import { LoggingUtility
 } from '@/utils/LoggingUtility';
import { RAGService } from '@/services/RAGService';
import manifest from 'manifest.json';
import { useState } from "react";
import {
	DEFAULT_RESPONSE_NOTE_TEMPLATE,
	RESPONSE_NOTE_TEMPLATE_HELP,
	RESPONSE_TEMPLATE_PRESETS,
	ResponseTemplatePresetId
} from '@/utils/TemplateVariableRenderer';





export class SettingsPage extends PluginSettingTab 
{
    plugin: LocalLLMPlugin;

    constructor(app: App, plugin: LocalLLMPlugin) {
        super(app, plugin);
        this.plugin = plugin;}

	// Guard to avoid recursive programmatic updates
	private _updatingPersonality: boolean = false;
	// UI references to keep panels in sync
	private personalityPreviewTextArea?: HTMLTextAreaElement;
	private personalityDropdown?: DropdownComponent;
	private modelDropdown?: DropdownComponent;
	private embeddingModelDropdown?: DropdownComponent;
	private contextModeDropdown?: DropdownComponent;
	private contextModeSyncIntervalId?: number;

	async reloadPlugin()
	{
        
	}

	display(): void 
	{

		
		const { containerEl } = this;
		containerEl.empty();
		this.stopContextModeSync();

		const tabs = containerEl.createEl('div', { cls: 'local-llm-tabs' });
		const tabList = tabs.createEl('div', { cls: 'local-llm-tablist' });
		const panels = tabs.createEl('div', { cls: 'local-llm-panels' });

		const makeTab = (label: string, renderFn: (el: HTMLElement, s: LocalLLMSettings) => void) => {

		const btn = tabList.createEl('button', { cls: 'local-llm-tab', text: label });
		const panel = panels.createEl('div', { cls: 'local-llm-panel' });
		btn.addEventListener('click', () => {
		tabList.querySelectorAll('.local-llm-tab').forEach(b => b.classList.remove('active'));
		panels.querySelectorAll('.local-llm-panel').forEach(p => p.classList.remove('active'));
		btn.classList.add('active');
		panel.classList.add('active');
		});
		// render into panel
		renderFn(panel, this.plugin.settings);
		return { btn, panel };
		};




		makeTab('LLM Config', (el, s) => this.visualizeSettings_LLMConfig(el, s));
		makeTab('System Prompt', (el, s) => this.visualizeSettings_SystemPrompt(el, s));
		makeTab('Templates', (el, s) => this.visualizeSettings_Templates(el, s));
		makeTab('Auto Tag', (el, s) => this.visualizeSettings_AutoTag(el, s));
		// add more tabs as needed:
		//makeTab('Search', (el, s) => this.visualizeSettings_Search(el, s));
		makeTab('RAG', (el, s) => this.visualizeSettings_RAG(el, s));
		makeTab('Debug', (el, s) => this.visualizeSettings_Debug(el, s));

		// activate first tab
		tabList.querySelector('.local-llm-tab')?.classList.add('active');
		panels.querySelector('.local-llm-panel')?.classList.add('active');



	}

	private visualizeSettings_AutoTag(containerEl: HTMLElement, LocalLLMSettings: LocalLLMSettings): void {
		new Setting(containerEl).setName('Auto Tag').setHeading();

		new Setting(containerEl)
			.setName('User-defined tag dictionary')
			.setDesc('One tag per line. Auto Tag will still generate tags, but will prefer adding relevant tags from this dictionary when appropriate.')
			.addTextArea(text => text
				.setPlaceholder('project/research\nml/embedding\nmeeting-notes')
				.setValue((this.plugin.settings.autoTagDictionary || []).join('\n'))
				.then((text) => {
					text.inputEl.rows = 8;
					text.inputEl.addClass('local-llm-exclusion-textarea');
					text.inputEl.addClass('local-llm-exclusion-textarea-large');
				})
				.onChange(async (value) => {
					this.plugin.settings.autoTagDictionary = this.parseMultilineList(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto tag workload')
			.setDesc('Controls how many notes are processed per chunk during folder auto-tag runs.')
			.addDropdown(dropdown => dropdown
				.addOption('small', 'Small chunks (more responsive, lower burst load)')
				.addOption('medium', 'Medium chunks (balanced)')
				.addOption('large', 'Large chunks (faster throughput, higher burst load)')
				.setValue(this.plugin.settings.autoTagWorkload || 'medium')
				.onChange(async (value) => {
					if (value !== 'small' && value !== 'medium' && value !== 'large') {
						return;
					}

					this.plugin.settings.autoTagWorkload = value;
					await this.plugin.saveSettings();
				}));

		const availableConnections = (this.plugin.settings.multiAIConnections || []).filter(conn => !conn.isSleeping);
		if (availableConnections.length > 0) {
			new Setting(containerEl)
				.setName('Auto tag connection')
				.setDesc('Choose which connection Auto Tag should use. Default uses the main LLM Config endpoint.')
				.addDropdown(dropdown => {
					dropdown.addOption('', 'Default connection');
					availableConnections.forEach(conn => {
						dropdown.addOption(conn.id, conn.name || conn.id);
					});

					const selectedConnection = this.plugin.settings.autoTagConnectionId || '';
					if (selectedConnection && !availableConnections.some(conn => conn.id === selectedConnection)) {
						this.plugin.settings.autoTagConnectionId = undefined;
						dropdown.setValue('');
					} else {
						dropdown.setValue(selectedConnection);
					}

					dropdown.onChange(async (value) => {
						this.plugin.settings.autoTagConnectionId = value.trim().length > 0 ? value : undefined;
						await this.plugin.saveSettings();
					});
				});
		}
	}

	private visualizeSettings_Templates(containerEl: HTMLElement, LocalLLMSettings: LocalLLMSettings): void {
		new Setting(containerEl).setName('Response Templates').setHeading();
		let templateTextAreaEl: HTMLTextAreaElement | null = null;

		const applyPresetTemplate = async (presetId: ResponseTemplatePresetId): Promise<void> => {
			const preset = RESPONSE_TEMPLATE_PRESETS[presetId];
			if (!preset) {
				return;
			}

			this.plugin.settings.responseNoteTemplate = preset.template;
			this.plugin.settings.enableResponseNoteTemplate = true;
			await this.plugin.saveSettings();
			if (templateTextAreaEl) {
				templateTextAreaEl.value = preset.template;
			}
			new Notice(`Applied template preset: ${preset.label}`);
		};

		new Setting(containerEl)
			.setName('Use response note template')
			.setDesc('When enabled, saved editor-action notes use a structured template for easier onboarding and cleaner outputs.')
			.addToggle(toggle => toggle
				.setValue(!!this.plugin.settings.enableResponseNoteTemplate)
				.onChange(async (value) => {
					this.plugin.settings.enableResponseNoteTemplate = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Starter presets')
			.setDesc('One-click presets for non-technical users. Select a format and start saving responses immediately.')
			.addButton(button => button
				.setButtonText('Research Summary')
				.onClick(async () => {
					await applyPresetTemplate('research-summary');
				}))
			.addButton(button => button
				.setButtonText('Meeting Notes')
				.onClick(async () => {
					await applyPresetTemplate('meeting-notes');
				}))
			.addButton(button => button
				.setButtonText('Journal Reflection')
				.onClick(async () => {
					await applyPresetTemplate('journal-reflection');
				}));

		new Setting(containerEl)
			.setName('Response note template')
			.setDesc(`Variables: ${RESPONSE_NOTE_TEMPLATE_HELP}`)
			.addTextArea(text => {
				text.setValue(this.plugin.settings.responseNoteTemplate || DEFAULT_RESPONSE_NOTE_TEMPLATE)
					.setPlaceholder(DEFAULT_RESPONSE_NOTE_TEMPLATE)
					.onChange(async (value) => {
						this.plugin.settings.responseNoteTemplate = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 12;
				text.inputEl.cols = 60;
				templateTextAreaEl = text.inputEl;
			});

		new Setting(containerEl)
			.setName('Reset response template')
			.setDesc('Restore the default beginner-friendly template.')
			.addButton(button => button
				.setButtonText('Reset template')
				.onClick(async () => {
					this.plugin.settings.responseNoteTemplate = DEFAULT_RESPONSE_NOTE_TEMPLATE;
					await this.plugin.saveSettings();
					new Notice('Response note template reset to default.');
					this.display();
				}));
	}

	hide(): void {
		this.stopContextModeSync();
	}

	private startContextModeSync(): void {
		this.stopContextModeSync();
		this.contextModeSyncIntervalId = window.setInterval(() => {
			this.syncContextModeDropdownFromSettings();
		}, 600);
	}

	private stopContextModeSync(): void {
		if (this.contextModeSyncIntervalId !== undefined) {
			window.clearInterval(this.contextModeSyncIntervalId);
			this.contextModeSyncIntervalId = undefined;
		}
	}

	private syncContextModeDropdownFromSettings(): void {
		if (!this.contextModeDropdown) {
			return;
		}

		const desiredMode = this.plugin.settings.contextMode;
		if (this.contextModeDropdown.selectEl.value !== desiredMode) {
			this.contextModeDropdown.setValue(desiredMode);
		}
	}

	private refreshAutoTagTabPanel(): void {
		const tabButtons = Array.from(this.containerEl.querySelectorAll('.local-llm-tab')) as HTMLElement[];
		const tabPanels = Array.from(this.containerEl.querySelectorAll('.local-llm-panel')) as HTMLElement[];

		const autoTagIndex = tabButtons.findIndex((button) => button.textContent?.trim() === 'Auto Tag');
		if (autoTagIndex < 0 || autoTagIndex >= tabPanels.length) {
			return;
		}

		const autoTagPanel = tabPanels[autoTagIndex];
		autoTagPanel.empty();
		this.visualizeSettings_AutoTag(autoTagPanel, this.plugin.settings);
	}
//**************************** */
//**************************** */
	/**
	 * Load available models from the LM Studio /v1/models endpoint
	 */




	private async loadAvailableModels(): Promise<void> 
	{
		const dropdown = this.modelDropdown;
		if (!dropdown) return;
		await this.loadAvailableModelsForConfig(dropdown, {
			apiEndpoint: this.plugin.settings.apiEndpoint,
			apiKey: this.plugin.settings.apiKey,
			savedModel: this.plugin.settings.model || '',
			errorNotice: 'Failed to load models from LM Studio. Please check your API endpoint and ensure LM Studio is running.'
		});
	}

	private async loadAvailableModelsForConfig(
		dropdown: DropdownComponent,
		config: {
			apiEndpoint: string;
			apiKey?: string;
			savedModel?: string;
			errorNotice?: string;
		}
	): Promise<void> {
		if (!dropdown) return;

		try {
			// Show loading state
			const savedModel = config.savedModel || '';
			dropdown.selectEl.disabled = true;
			dropdown.selectEl.empty();
			dropdown.selectEl.createEl('option', { value: '', text: 'Loading models...' });

			// Create a temporary LLM service to fetch models
			const { createLLMService } = await import('@/services/LLMService');
			const llmService = createLLMService({
				apiEndpoint: config.apiEndpoint,
				apiKey: config.apiKey
			});

			// Fetch available models
			const models = await llmService.getAvailableModels();

			// Clear dropdown and add default option
			dropdown.selectEl.empty();
			dropdown.addOption('', 'Auto (server chooses)');

			// Add available models
			if (models.length > 0) {
				models.forEach(model => {
					if (!model.toLowerCase().includes('embed')) {
						dropdown.addOption(model, model);
					}
				});
			} else {
				dropdown.addOption('', 'No models available');
			}

			// Restore saved selection if it still exists
			if (savedModel && models.includes(savedModel)) {
				dropdown.setValue(savedModel);
			} else {
				dropdown.setValue('');
			}

			// Re-enable dropdown
			dropdown.selectEl.disabled = false;

		} catch (error) {
			LoggingUtility.error('Failed to load available models:', error);

			// Show error state
			dropdown.selectEl.empty();
			dropdown.addOption('', 'Auto (server chooses)');
			dropdown.addOption('', 'Failed to load models');

			// Restore saved model even in error state
			const savedModel = config.savedModel || '';
			dropdown.setValue(savedModel);
			dropdown.selectEl.disabled = false;

			// Show notice to user
			if (config.errorNotice) {
				new Notice(config.errorNotice);
			}
		}
	}

	/**
	 * Load available embedding models from the LM Studio model listing endpoints.
	 * Falls back to the current default embedding model when no embedding models are returned.
	 */
	private async loadAvailableEmbeddingModels(): Promise<void> {
		const dropdown = this.embeddingModelDropdown;
		if (!dropdown) return;

		const currentOrDefaultModel = this.plugin.settings.embeddingModel || this.plugin.settings.embeddingModel;

		try {
			dropdown.selectEl.disabled = true;
			dropdown.selectEl.empty();
			dropdown.selectEl.createEl('option', { value: '', text: 'Loading embedding models...' });

			const { createLLMService } = await import('@/services/LLMService');
			const llmService = createLLMService({
				apiEndpoint: this.plugin.settings.embeddingEndpoint,
				apiKey: this.plugin.settings.apiKey
			});


			const models = await llmService.getAvailableEmbeddingModels();

			dropdown.selectEl.empty();

			if (models.length > 0) {
				models.forEach((model) => {
					dropdown.addOption(model, model);
				});

				if (models.includes(currentOrDefaultModel)) {
					dropdown.setValue(currentOrDefaultModel);
				} else {
					dropdown.setValue(models[0]);
					this.plugin.settings.embeddingModel = models[0];
					await this.plugin.saveSettings();
				}
			} else {
				dropdown.addOption(currentOrDefaultModel, currentOrDefaultModel);
				dropdown.setValue(currentOrDefaultModel);
				this.plugin.settings.embeddingModel = currentOrDefaultModel;
				await this.plugin.saveSettings();
			}

			dropdown.selectEl.disabled = false;
		} catch (error) {
			LoggingUtility.error('Failed to load available embedding models:', error);

			dropdown.selectEl.empty();
			dropdown.addOption(currentOrDefaultModel, currentOrDefaultModel);
			dropdown.setValue(currentOrDefaultModel);
			dropdown.selectEl.disabled = false;
		}
	}

	/**
	 * Update the RAG status display after rebuilding
	 */
	private updateStatusDisplay(containerEl: HTMLElement, stats: { documentCount: number; lastUpdated: Date; sizeInBytes: number }): void {
		// Find the status setting by looking for its text content
		const settings = containerEl.querySelectorAll('.setting-item');
		for (let i = 0; i < settings.length; i++) {
			const setting = settings[i];
			const nameEl = setting.querySelector('.setting-item-name');
			if (nameEl && nameEl.textContent === 'RAG database status') {
				const descEl = setting.querySelector('.setting-item-description');
				if (descEl) {
					const detailedStatus = this.plugin.ragService.getDetailedStatus();
					descEl.textContent = `Documents indexed: ${stats.documentCount} (${detailedStatus.textStats.documentCount} text, ${detailedStatus.imageStats.documentCount} image) | Files: ${detailedStatus.totalFiles} | Last updated: ${stats.lastUpdated.toLocaleString()} | Size: ${(stats.sizeInBytes / 1024).toFixed(1)} KB | Image extractor: ${detailedStatus.imageTextExtractorAvailable ? 'available' : 'unavailable'}`;
				}
				break;
			}
		}
	}

	private parseMultilineList(value: string): string[] {
		return value
			.split('\n')
			.map(line => line.trim())
			.filter(line => line.length > 0);
	}

	private getErrorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private setpersonalityPreview(containerEl: HTMLElement,LocalLLMSettings: LocalLLMSettings ): void {
		const name = this.plugin.settings.personalityName || [];
		const trait = this.plugin.settings.personalityPrompt || [];

		if (name.length === 0 || trait.length === 0) {
			const previewBoxEmpty = containerEl.querySelector('.local-llm-personality-preview') as HTMLElement;
			if (previewBoxEmpty) previewBoxEmpty.textContent = 'No personalities configured. Add personalities in settings.';
			return;
		}


		const personalityMap: { [key: string]: string } = {};
		for (let i = 0; i < name.length; i++) {
			personalityMap[name[i].trim()] = (trait[i] || '').trim();
		}

		const previewBox = containerEl.querySelector('.local-llm-personality-preview') as HTMLElement;
		if (previewBox) {
			const selectedPersonalityValue: unknown = Array.isArray(LocalLLMSettings.personalityName)
				? LocalLLMSettings.personalityName[0]
				: LocalLLMSettings.personalityName;
			const selectedPersonality = typeof selectedPersonalityValue === 'string' ? selectedPersonalityValue : '';
			const selectedPersonalityPromptValue: unknown = Array.isArray(LocalLLMSettings.personalityPrompt)
				? LocalLLMSettings.personalityPrompt[0]
				: LocalLLMSettings.personalityPrompt;
			const selectedPersonalityPrompt = typeof selectedPersonalityPromptValue === 'string' ? selectedPersonalityPromptValue : '';
			previewBox.textContent = personalityMap[selectedPersonality.toUpperCase()] || selectedPersonalityPrompt || 'No traits found for this personality. Please check your settings.';
		}
	}


	/**
	 * Centralized handler to update personality settings and keep UI in sync
	 */
	private async handlePersonalityChange(value: string, containerEl?: HTMLElement): Promise<void> {
		if (this._updatingPersonality) return;
		try {
			this._updatingPersonality = true;

			this.plugin.settings.personalityName = value;
			this.plugin.settings.selectedPersonality = value;
			this.plugin.settings.personalityPrompt = [PersonalityTrait[value.toUpperCase() as keyof typeof PersonalityTrait] || ''];

			if (value == 'DEFAULT' || value == 'NONE' || value == 'Default' || value == 'None') {
				this.plugin.settings.augmentSystemPromptwithPersonality = true;
			} else {
				this.plugin.settings.augmentSystemPromptwithPersonality = false;
			}

			await this.plugin.saveSettings();

			// Update preview textarea if present
			if (this.personalityPreviewTextArea) {
				this.personalityPreviewTextArea.value = this.plugin.settings.personalityPrompt?.[0] || '';
			}

			// Programmatically set other dropdowns (safe with guard)
			if (this.personalityDropdown && typeof this.personalityDropdown.setValue === 'function') {
				this.personalityDropdown.setValue(value);
			}
			// Refresh preview rendering if container provided
			if (containerEl) {
				this.setpersonalityPreview(containerEl, this.plugin.settings);
			}

			// Notify open chat views so their UI updates immediately
			if (typeof this.plugin.notifyChatViewsOfSettingsChange === 'function') {
				this.plugin.notifyChatViewsOfSettingsChange();
			} else {
				const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
				leaves.forEach(leaf => {
					const view = leaf.view as Partial<Pick<ChatView, 'updateLLMServiceFromSettings' | 'updatePersonalityDropdownFromSettings'>>;
					if (typeof view.updateLLMServiceFromSettings === 'function') {
						view.updateLLMServiceFromSettings();
					}
					if (typeof view.updatePersonalityDropdownFromSettings === 'function') {
						view.updatePersonalityDropdownFromSettings();
					}
				});
			}

		} finally {
			this._updatingPersonality = false;
		}
	}

	public addStyledSlider = (setting: Setting, opts: {
			min: number, max: number, step: number, value: number, onChange: (value: number) => Promise<void>,
			format?: (value: number) => string
		}) => {
			let valueLabel: HTMLSpanElement | null = null;
			setting.addSlider(slider => {
				slider.setLimits(opts.min, opts.max, opts.step)
					.setValue(opts.value)
					.setDynamicTooltip()
					.onChange(async (value) => {
						if (valueLabel) valueLabel.textContent = opts.format ? opts.format(value) : value.toString();
						await opts.onChange(value);
					});
				slider.sliderEl.classList.add('local-llm-settings-slider');
				// Live update label as slider moves
				slider.sliderEl.addEventListener('input', (e: Event) => {
					const val = parseFloat((e.target as HTMLInputElement).value);
					if (valueLabel) valueLabel.textContent = opts.format ? opts.format(val) : val.toString();
				});
				const labelEl = slider.sliderEl.ownerDocument.createElement('span');
				labelEl.className = 'local-llm-slider-value';
				labelEl.textContent = opts.format ? opts.format(opts.value) : opts.value.toString();
				slider.sliderEl.parentElement?.appendChild(labelEl);
				valueLabel = labelEl;
			});
		};

	private visualizeSettings_LLMConfig(containerEl: HTMLElement, LocalLLMSettings: LocalLLMSettings): void
	{
	
		const config = LocalLLMSettings;


		// Helper to create a slider with live value label and custom style
		const addStyledSlider = (setting: Setting, opts: {
			min: number, max: number, step: number, value: number, onChange: (value: number) => Promise<void>,
			format?: (value: number) => string
		}) => {
			let valueLabel: HTMLSpanElement | null = null;
			setting.addSlider(slider => {
				slider.setLimits(opts.min, opts.max, opts.step)
					.setValue(opts.value)
					.setDynamicTooltip()
					.onChange(async (value) => {
						if (valueLabel) valueLabel.textContent = opts.format ? opts.format(value) : value.toString();
						await opts.onChange(value);
					});
				slider.sliderEl.classList.add('local-llm-settings-slider');
				// Live update label as slider moves
				slider.sliderEl.addEventListener('input', (e: Event) => {
					const val = parseFloat((e.target as HTMLInputElement).value);
					if (valueLabel) valueLabel.textContent = opts.format ? opts.format(val) : val.toString();
				});
				const labelEl = slider.sliderEl.ownerDocument.createElement('span');
				labelEl.className = 'local-llm-slider-value';
				labelEl.textContent = opts.format ? opts.format(opts.value) : opts.value.toString();
				slider.sliderEl.parentElement?.appendChild(labelEl);
				valueLabel = labelEl;
			});
		};

			new Setting(containerEl)
			.setName('Context mode')
			.setDesc('The default context mode to use when opening a new chat')
			.addDropdown(dropdown => {
				this.contextModeDropdown = dropdown;
				dropdown
					.addOption(ContextMode.CURRENT_NOTE, 'Current Note')
					.addOption(ContextMode.LINKED_NOTES, 'Linked Notes')
					.addOption(ContextMode.CURRENT_FOLDER, 'Current Folder')
					.addOption(ContextMode.DAILY_NOTES, 'Daily Notes')
					.addOption(ContextMode.BOOKMARKED_NOTES, 'Bookmarked Notes')
					.addOption(ContextMode.SEARCH_QUERY_SCOPE, 'Search Query Scope')
					.addOption(ContextMode.OPEN_NOTES, 'Open Tabs')
					.addOption(ContextMode.SEARCH, 'All Notes')
					.addOption(ContextMode.NONE, 'No Context')
					.setValue(this.plugin.settings.contextMode)
					.onChange(async (value) => {
						this.plugin.settings.contextMode = value as ContextMode;
						await this.plugin.saveSettings();
					});
			});
		this.syncContextModeDropdownFromSettings();
		this.startContextModeSync();

						new Setting(containerEl)
			.setName('API endpoint')
			.setDesc('The endpoint URL for your local LLM API')
			.addText(text => text
				.setPlaceholder('http://localhost:1234/v1/chat/completions')
				.setValue(this.plugin.settings.apiEndpoint)
				.onChange(async (value) => {
					this.plugin.settings.apiEndpoint = value;
					await this.plugin.saveSettings();
				}));
		//**************************** */
		new Setting(containerEl)
			.setName('API key')
			.setDesc('Optional API key sent as a Bearer token for API authentication.  To generate, goto LM Studio, click Developer tab, Server Settings, and click Manage Tokens')
			.addText(text => text
				.setPlaceholder('Enter API key')
				.setValue(this.plugin.settings.apiKey ?? '')
				.onChange(async (value) => {
					const trimmedValue = value.trim();
					this.plugin.settings.apiKey = trimmedValue.length > 0 ? trimmedValue : undefined;
					await this.plugin.saveSettings();
				}));
		//**************************** */
		// Model dropdown setting
		const modelSetting = new Setting(containerEl)
			.setName('Model')
			.setDesc('Select a specific model to use. (Loaded from LM Studio downloaded models.)')
			.addDropdown(dropdown => {
				// Add empty option for no model selection
				dropdown.addOption('', 'Auto (server chooses)');

				// Set current value from saved settings
				const savedModel = this.plugin.settings.model || '';
				dropdown.setValue(savedModel);

				dropdown.onChange(async (value) => {
					this.plugin.settings.model = value === '' ? undefined : value;
					await this.plugin.saveSettings();
				});

				// Store reference to dropdown for dynamic updates
				this.modelDropdown = dropdown;
			});

		// Add refresh models button
		modelSetting.addButton(button => button
			.setButtonText('Refresh Models')
			.setTooltip('Load available models from LM Studio')
			.onClick(async () => {
				await this.loadAvailableModels();
			}));

		// Load models automatically when settings are displayed
		// Use setTimeout to ensure the dropdown is fully initialized first
		setTimeout(() => {
			this.loadAvailableModels();
		}, 0);
		//**************************** */
		addStyledSlider(
			new Setting(containerEl)
				.setName('Max tokens')
				.setDesc('Maximum number of tokens in the response'),
			{
				min: 100, max: 40000, step: 100, value: this.plugin.settings.maxTokens,
				onChange: async (value) => {
					this.plugin.settings.maxTokens = value;
					await this.plugin.saveSettings();
				}
			}
		);
		//**************************** */
		addStyledSlider(
			new Setting(containerEl)
				.setName('Temperature')
				.setDesc('Controls randomness in the response (0 = deterministic, 1 = very random) 0.7 is recommended for most models'),
			{
				min: 0, max: 1, step: 0.01, value: this.plugin.settings.temperature,
				onChange: async (value) => {
					this.plugin.settings.temperature = value;
					await this.plugin.saveSettings();
				},
				format: (v) => v.toFixed(2)
			}
		);

		const getConnections = (): AIConnectionConfig[] => {
			if (!Array.isArray(this.plugin.settings.multiAIConnections)) {
				this.plugin.settings.multiAIConnections = [];
			}

			return this.plugin.settings.multiAIConnections as AIConnectionConfig[];
		};

		const createNewConnection = (): AIConnectionConfig => ({
			id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			name: `Connection ${getConnections().length + 1}`,
			isSleeping: false,
			contextMode: this.plugin.settings.contextMode,
			apiEndpoint: this.plugin.settings.apiEndpoint,
			apiKey: this.plugin.settings.apiKey,
			model: this.plugin.settings.model,
			maxTokens: this.plugin.settings.maxTokens,
			temperature: this.plugin.settings.temperature
		});

		let advancedVisible = false;
		const advancedSection = containerEl.createDiv({
			cls: 'local-llm-multi-ai-advanced local-llm-multi-ai-hidden'
		});

		const renderConnections = () => {
			advancedSection.empty();

			new Setting(advancedSection)
				.setName('Named AI connections')
				.setDesc('Add external providers like ChatGPT or Claude. Each connection keeps its own context mode, endpoint, key, model, max tokens, and temperature.')
				.addButton(button => button
					.setButtonText('Add connection')
					.onClick(async () => {
						const connections = getConnections();
						connections.push(createNewConnection());
						await this.plugin.saveSettings();
						this.refreshAutoTagTabPanel();
						renderConnections();
					}));

			const connections = getConnections();
			if (connections.length === 0) {
				advancedSection.createEl('p', {
					cls: 'local-llm-multi-ai-empty',
					text: 'No additional connections yet. Add one to expose a connection selector in Chat View.'
				});
				return;
			}

			connections.forEach((connection, index) => {
				const card = advancedSection.createDiv({ cls: `local-llm-connection-card${connection.isSleeping ? ' local-llm-connection-card-sleeping' : ''}` });
				const isSleeping = !!connection.isSleeping;

				new Setting(card)
					.setName(`Connection ${index + 1}`)
					.setDesc(isSleeping ? 'Sleeping (inactive) - click Wake to reactivate this connection.' : 'Configure this provider profile')
					.addButton(button => button
						.setButtonText(isSleeping ? 'Wake' : 'Sleep')
						.onClick(async () => {
							connection.isSleeping = !isSleeping;
							if (connection.isSleeping) {
								if (this.plugin.settings.activeAIConnectionId === connection.id) {
									this.plugin.settings.activeAIConnectionId = undefined;
								}
								if (this.plugin.settings.autoTagConnectionId === connection.id) {
									this.plugin.settings.autoTagConnectionId = undefined;
								}
							}
							await this.plugin.saveSettings();
							this.refreshAutoTagTabPanel();
							renderConnections();
						}))
					.addButton(button => button
						.setButtonText('Delete')
						.then((component) => {
							component.buttonEl.classList.add('mod-warning');
						})
						.onClick(async () => {
							const updated = getConnections().filter((entry) => entry.id !== connection.id);
							this.plugin.settings.multiAIConnections = updated;
							if (this.plugin.settings.activeAIConnectionId === connection.id) {
								this.plugin.settings.activeAIConnectionId = undefined;
							}
							if (this.plugin.settings.autoTagConnectionId === connection.id) {
								this.plugin.settings.autoTagConnectionId = undefined;
							}
							await this.plugin.saveSettings();
							this.refreshAutoTagTabPanel();
							renderConnections();
						}));
				if (isSleeping) {
					card.createEl('p', {
						cls: 'local-llm-multi-ai-empty',
						text: `${connection.name || `Connection ${index + 1}`} is sleeping. Configuration is preserved and hidden.`
					});
					return;
				}

				new Setting(card)
					.setName('Connection name')
					.setDesc('Label shown in Chat View connection selector')
					.addText(text => text
						.setPlaceholder('ChatGPT, Claude, Remote LM Studio')
						.setValue(connection.name || '')
						.onChange(async (value) => {
							const trimmed = value.trim();
							connection.name = trimmed.length > 0 ? trimmed : `Connection ${index + 1}`;
							await this.plugin.saveSettings();
							this.refreshAutoTagTabPanel();
						}));

				new Setting(card)
					.setName('Context mode')
					.setDesc('Context mode used when this connection is selected in Chat View')
					.addDropdown(dropdown => dropdown
						.addOption(ContextMode.CURRENT_NOTE, 'Current Note')
						.addOption(ContextMode.LINKED_NOTES, 'Linked Notes')
						.addOption(ContextMode.CURRENT_FOLDER, 'Current Folder')
						.addOption(ContextMode.DAILY_NOTES, 'Daily Notes')
						.addOption(ContextMode.BOOKMARKED_NOTES, 'Bookmarked Notes')
						.addOption(ContextMode.SEARCH_QUERY_SCOPE, 'Search Query Scope')
						.addOption(ContextMode.OPEN_NOTES, 'Open Tabs')
						.addOption(ContextMode.SEARCH, 'All Notes')
						.addOption(ContextMode.NONE, 'No Context')
						.setValue(connection.contextMode || this.plugin.settings.contextMode)
						.onChange(async (value) => {
							connection.contextMode = value as ContextMode;
							await this.plugin.saveSettings();
						}));

				new Setting(card)
					.setName('API endpoint')
					.setDesc('OpenAI-compatible chat completions endpoint for this connection')
					.addText(text => text
						.setPlaceholder('https://api.openai.com/v1/chat/completions')
						.setValue(connection.apiEndpoint || '')
						.onChange(async (value) => {
							connection.apiEndpoint = value.trim();
							await this.plugin.saveSettings();
						}));

				new Setting(card)
					.setName('API key')
					.setDesc('Optional Bearer token for this connection')
					.addText(text => text
						.setPlaceholder('Enter API key')
						.setValue(connection.apiKey || '')
						.onChange(async (value) => {
							const trimmed = value.trim();
							connection.apiKey = trimmed.length > 0 ? trimmed : undefined;
							await this.plugin.saveSettings();
						}));

				let connectionModelDropdown: DropdownComponent | null = null;
				const connectionModelSetting = new Setting(card)
					.setName('Model')
					.setDesc('Optional model name sent in the request payload')
					.addDropdown(dropdown => {
						connectionModelDropdown = dropdown;
						dropdown.addOption('', 'Auto (server chooses)');
						if (connection.model && connection.model.trim().length > 0) {
							dropdown.addOption(connection.model, connection.model);
							dropdown.setValue(connection.model);
						} else {
							dropdown.setValue('');
						}

						dropdown.onChange(async (value) => {
							connection.model = value.trim().length > 0 ? value : undefined;
							await this.plugin.saveSettings();
						});
					});

				connectionModelSetting.addButton(button => button
					.setButtonText('Refresh Models')
					.setTooltip('Load available models from this connection endpoint')
					.onClick(async () => {
						if (!connectionModelDropdown) {
							return;
						}

						await this.loadAvailableModelsForConfig(connectionModelDropdown, {
							apiEndpoint: connection.apiEndpoint,
							apiKey: connection.apiKey,
							savedModel: connection.model || '',
							errorNotice: `Failed to load models for ${connection.name || `Connection ${index + 1}`}. Check API endpoint and key.`
						});

						const selected = connectionModelDropdown.selectEl.value.trim();
						connection.model = selected.length > 0 ? selected : undefined;
						await this.plugin.saveSettings();
					}));

				new Setting(card)
					.setName('Max tokens')
					.setDesc('Maximum response tokens for this connection')
					.addText(text => text
						.setPlaceholder('10000')
						.setValue(String(connection.maxTokens ?? this.plugin.settings.maxTokens))
						.onChange(async (value) => {
							const parsed = Number.parseInt(value, 10);
							if (Number.isFinite(parsed) && parsed > 0) {
								connection.maxTokens = parsed;
								await this.plugin.saveSettings();
							}
						}));

				new Setting(card)
					.setName('Temperature')
					.setDesc('Sampling temperature (0 to 1) for this connection')
					.addText(text => text
						.setPlaceholder('0.70')
						.setValue(String(connection.temperature ?? this.plugin.settings.temperature))
						.onChange(async (value) => {
							const parsed = Number.parseFloat(value);
							if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
								connection.temperature = parsed;
								await this.plugin.saveSettings();
							}
						}));
			});
		};

		new Setting(containerEl)
			.setName('Multi AI connections')
			.setDesc('Advanced: create named provider profiles and switch between them from Chat View.')
			.addButton(button => button
				.setButtonText('Show Advanced')
				.onClick(() => {
					advancedVisible = !advancedVisible;
					if (advancedVisible) {
						button.setButtonText('Hide Advanced');
						advancedSection.removeClass('local-llm-multi-ai-hidden');
					} else {
						button.setButtonText('Show Advanced');
						advancedSection.addClass('local-llm-multi-ai-hidden');
					}
				}));

		renderConnections();
	}

	private visualizeSettings_SystemPrompt(containerEl: HTMLElement, LocalLLMSettings: LocalLLMSettings): void
	{
		//**************************** */
		const names = Object.keys(PersonalityMode) || [];
		const current = this.plugin.settings.personalityName || (names[0] || '');
		// System prompt setting with textarea below
		new Setting(containerEl)
			.setName('What personal preferences should be considered in responses?')
			.setDesc('Customize the AI\'s personality and behavior. This system prompt will be used in all conversations.');

		const systemPromptTextArea = containerEl.createEl('textarea', {
			cls: 'local-llm-system-prompt-textarea',
			attr: {
				placeholder: 'e.g. "You are a helpful assistant. Please be concise and friendly. Consider that I prefer practical examples over theory."',
				rows: '4'
			}
		});
		systemPromptTextArea.value = this.plugin.settings.systemPrompt;

		systemPromptTextArea.addEventListener('input', () => {
			void (async () => {
				this.plugin.settings.systemPrompt = systemPromptTextArea.value;
				await this.plugin.saveSettings();
			})();
		});

		//**************************** */
		// Scaffold: response formatting settings
		new Setting(containerEl)
			.setName('Enable short responses')
			.setDesc('When enabled, the assistant will prefer concise answers')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableShortResponses)
				.onChange(async (value) => {
					this.plugin.settings.enableShortResponses = value;
					await this.plugin.saveSettings();
				}));

		//**************************** */			
		// Personality selector + preview: one control showing names and previewing traits
		new Setting(containerEl)
			.setName('Personality')
			.setDesc('Select a personality to preview its traits')
			.addDropdown(dropdown => {
				

				// Populate dropdown options
				dropdown.addOption('', 'None');
				names.forEach(name => dropdown.addOption(name, name));

				// Set current value
				

	
				// keep a reference for programmatic updates
				this.personalityDropdown = dropdown;
				dropdown.setValue(current);
				dropdown.onChange((value) => {
					void this.handlePersonalityChange(value, containerEl);
				});



			});

			const personalityPreviewTextArea = containerEl.createEl('textarea', {
				cls: 'local-llm-personality-preview',
				value: this.plugin.settings.personalityPrompt?.[0] || '',
				});
			// keep reference for updates from other panels
			this.personalityPreviewTextArea = personalityPreviewTextArea;
			personalityPreviewTextArea.value = this.plugin.settings.personalityPrompt?.[0] || '';



	}

	private visualizeSettings_Search(containerEl: HTMLElement, LocalLLMSettings: LocalLLMSettings): void
	{

			const addStyledSlider = (setting: Setting, opts: {
			min: number, max: number, step: number, value: number, onChange: (value: number) => Promise<void>,
			format?: (value: number) => string
		}) => {
			let valueLabel: HTMLSpanElement | null = null;
			setting.addSlider(slider => {
				slider.setLimits(opts.min, opts.max, opts.step)
					.setValue(opts.value)
					.setDynamicTooltip()
					.onChange(async (value) => {
						if (valueLabel) valueLabel.textContent = opts.format ? opts.format(value) : value.toString();
						await opts.onChange(value);
					});
				slider.sliderEl.classList.add('local-llm-settings-slider');
				// Live update label as slider moves
				slider.sliderEl.addEventListener('input', (e: Event) => {
					const val = parseFloat((e.target as HTMLInputElement).value);
					if (valueLabel) valueLabel.textContent = opts.format ? opts.format(val) : val.toString();
				});
				const labelEl = slider.sliderEl.ownerDocument.createElement('span');
				labelEl.className = 'local-llm-slider-value';
				labelEl.textContent = opts.format ? opts.format(opts.value) : opts.value.toString();
				slider.sliderEl.parentElement?.appendChild(labelEl);
				valueLabel = labelEl;
			});
		};
		//**************************** */
		new Setting(containerEl).setName('Search').setHeading();
		//**************************** */
		addStyledSlider(
			new Setting(containerEl)
				.setName('Max search results')
				.setDesc('Maximum number of notes to include as context (uses RAG database for enhanced relevance)'),
			{
				
				min: 1, max: 10, step: 1,value: this.plugin.settings.ragMaxResults,
				onChange: async (value) => {
					this.plugin.settings.ragMaxResults = value;
					await this.plugin.saveSettings();
				}
			}
		);
		//**************************** */
		addStyledSlider(
			new Setting(containerEl)
				.setName('Context percentage from search')
				.setDesc('Percentage of max tokens to use for search context (50% = 2000 tokens if max tokens is 4000)'),
			{
				min: 10, max: 80, step: 5, value: this.plugin.settings.searchContextPercentage,
				onChange: async (value) => {
					this.plugin.settings.searchContextPercentage = value;
					await this.plugin.saveSettings();
				},
				format: (v) => v + '%'
			}
		);
		//**************************** */
		addStyledSlider(
			new Setting(containerEl)
				.setName('Search relevance threshold')
				.setDesc('Minimum relevance score for notes to be included using RAG similarity (0 = include all, 1 = very strict)'),
			{
				min: 0, max: 1, step: 0.1, value: this.plugin.settings.ragThreshold,
				onChange: async (value) => {
					this.plugin.settings.ragThreshold = value;
					await this.plugin.saveSettings();
				},
				format: (v) => v.toFixed(2)
			}
		);
	}

	private visualizeSettings_RAG(containerEl: HTMLElement, LocalLLMSettings: LocalLLMSettings): void
	{
		const addStyledSlider = (setting: Setting, opts: {
			min: number, max: number, step: number, value: number, onChange: (value: number) => Promise<void>,
			format?: (value: number) => string
		}) => {
			let valueLabel: HTMLSpanElement | null = null;
			setting.addSlider(slider => {
				slider.setLimits(opts.min, opts.max, opts.step)
					.setValue(opts.value)
					.setDynamicTooltip()
					.onChange(async (value) => {
						if (valueLabel) valueLabel.textContent = opts.format ? opts.format(value) : value.toString();
						await opts.onChange(value);
					});
				slider.sliderEl.classList.add('local-llm-settings-slider');
				// Live update label as slider moves
				slider.sliderEl.addEventListener('input', (e: Event) => {
					const val = parseFloat((e.target as HTMLInputElement).value);
					if (valueLabel) valueLabel.textContent = opts.format ? opts.format(val) : val.toString();
				});
				const labelEl = slider.sliderEl.ownerDocument.createElement('span');
				labelEl.className = 'local-llm-slider-value';
				labelEl.textContent = opts.format ? opts.format(opts.value) : opts.value.toString();
				slider.sliderEl.parentElement?.appendChild(labelEl);
				valueLabel = labelEl;
			});
		};
		//**************************** */
		new Setting(containerEl).setName('All Notes Search').setHeading();
		//**************************** */
		const ragStats = this.plugin.ragService.getStats();
		const detailedStatus = this.plugin.ragService.getDetailedStatus();
		new Setting(containerEl)
			.setName('RAG database status')
			.setDesc(`Documents indexed: ${ragStats.documentCount} (${detailedStatus.textStats.documentCount} text, ${detailedStatus.imageStats.documentCount} image) | Files: ${ragStats.fileCount} | Last updated: ${ragStats.lastUpdated.toLocaleString()} | Size: ${(ragStats.sizeInBytes / 1024).toFixed(1)} KB | Image processing: ${detailedStatus.imageProcessingEnabled ? 'enabled' : 'disabled'} | Image extractor: ${detailedStatus.imageTextExtractorAvailable ? 'available' : 'unavailable'}`);
		//**************************** */
		new Setting(containerEl).setName('Indexing Exclusions').setHeading();
		//**************************** */
		const excludedFoldersSetting = new Setting(containerEl)
			.setName('Excluded folders')
			.setDesc('One folder per line. Supports vault-relative paths (e.g. clippings/_resources) or absolute vault paths.')
			.addTextArea(text => text
				.setPlaceholder('clippings/_resources\nattachments/generated')
				.setValue((this.plugin.settings.excludedFolders || []).join('\n'))
				.then((text) => {
					text.inputEl.rows = 4;
					text.inputEl.addClass('local-llm-exclusion-textarea');
					text.inputEl.addClass('local-llm-exclusion-textarea-large');
				})
				.onChange(async (value) => {
					this.plugin.settings.excludedFolders = this.parseMultilineList(value);
					await this.plugin.saveSettings();
				}));
		excludedFoldersSetting.settingEl.addClass('local-llm-exclusion-setting');
		//**************************** */
		const excludedFilePatternsSetting = new Setting(containerEl)
			.setName('Excluded file patterns')
			.setDesc('One pattern per line. Examples: *.json, *.csv, *.png, Daily/*.tmp')
			.addTextArea(text => text
				.setPlaceholder('*.json\n*.csv\n*.png')
				.setValue((this.plugin.settings.excludedFilePatterns || []).join('\n'))
				.then((text) => {
					text.inputEl.rows = 3;
					text.inputEl.addClass('local-llm-exclusion-textarea');
					text.inputEl.addClass('local-llm-exclusion-textarea-compact');
				})
				.onChange(async (value) => {
					this.plugin.settings.excludedFilePatterns = this.parseMultilineList(value);
					await this.plugin.saveSettings();
				}));
		excludedFilePatternsSetting.settingEl.addClass('local-llm-exclusion-setting');
		//**************************** */
		// Smart update RAG database button
		new Setting(containerEl)
			.setName('Update RAG database')
			.setDesc('Update the RAG database by checking for changed files using checksums. Only processes files that have actually changed.')
			.addButton(button => button
				.setButtonText('Smart Update')
				.setCta()
				.onClick(async () => {
					button.setButtonText('Updating...');
					button.setDisabled(true);

					try {
						await this.plugin.ragService.buildIndex((current, total, message) => {
							this.plugin.notifyChatViewsOfRAGProgress(current, total, message);
						});

						// Update stats display
						const newStats = this.plugin.ragService.getStats();
						this.updateStatusDisplay(containerEl, newStats);

						// Notify chat views that indexing is complete
						this.plugin.notifyChatViewsOfRAGComplete();
					} catch (error) {
						LoggingUtility.error('RAG update failed:', error);
						new Notice(`RAG database update failed: ${this.getErrorMessage(error)}`);
					} finally {
						button.setButtonText('Smart Update');
						button.setDisabled(false);
					}
				}));
		//**************************** */
		// Force rebuild RAG database button
		new Setting(containerEl)
			.setName('Force rebuild RAG database')
			.setDesc('Completely rebuild the entire RAG database from scratch. Use this if you want to regenerate all embeddings.')
			.addButton(button => button
				.setButtonText('Force Rebuild')
				.setWarning()
				.onClick(async () => {
					button.setButtonText('Rebuilding...');
					button.setDisabled(true);

					try {
						await this.plugin.ragService.forceCompleteRebuildIndex((current, total, message) => {
							this.plugin.notifyChatViewsOfRAGProgress(current, total, message);
						});

						// Update stats display
						const newStats = this.plugin.ragService.getStats();
						this.updateStatusDisplay(containerEl, newStats);

						// Notify chat views that indexing is complete
						this.plugin.notifyChatViewsOfRAGComplete();

						new Notice('RAG database completely rebuilt!');
					} catch (error) {
						LoggingUtility.error('RAG rebuild failed:', error);
						new Notice(`RAG database rebuild failed: ${this.getErrorMessage(error)}`);
					} finally {
						button.setButtonText('Force Rebuild');
						button.setDisabled(false);
					}
				}));
		//**************************** */
		addStyledSlider(
			new Setting(containerEl)
				.setName('RAG relevance threshold')
				.setDesc('Minimum relevance score for RAG results (0 = include all, 1 = very strict)'),
			{
				min: 0, max: 1, step: 0.1, value: this.plugin.settings.ragThreshold,
				onChange: async (value) => {
					this.plugin.settings.ragThreshold = value;
					await this.plugin.saveSettings();
				},
				format: (v) => v.toFixed(2)
			}
		);
		//**************************** */
		addStyledSlider(
			new Setting(containerEl)
				.setName('Max RAG results')
				.setDesc('Maximum number of notes to retrieve from RAG database'),
			{
				min: 1, max: 10, step: 1, value: this.plugin.settings.ragMaxResults,
				onChange: async (value) => {
					this.plugin.settings.ragMaxResults = value;
					await this.plugin.saveSettings();
				}
			}
		);

		const graphHeading = new Setting(containerEl).setName('Graph Re-ranking').setHeading();
		const graphHeadingInfo = graphHeading.settingEl.createDiv({ cls: 'setting-item-description' });
		graphHeadingInfo.setText('Optional ranking controls for power users.');

		const graphHeadingActions = graphHeading.settingEl.createDiv({ cls: 'setting-item-control' });
		let graphAdvancedExpanded = !!this.plugin.settings.graphRerankAdvancedExpanded;
		const graphAdvancedToggle = graphHeadingActions.createEl('button', {
			text: graphAdvancedExpanded ? 'Hide' : 'Advanced',
			cls: 'mod-cta',
			attr: { type: 'button', 'aria-expanded': graphAdvancedExpanded ? 'true' : 'false' }
		});

		const graphAdvancedContainer = containerEl.createDiv({ cls: 'local-llm-graph-advanced-settings' });
		graphAdvancedContainer.style.display = graphAdvancedExpanded ? '' : 'none';

		graphAdvancedToggle.addEventListener('click', () => {
			void (async () => {
				graphAdvancedExpanded = !graphAdvancedExpanded;
				graphAdvancedContainer.style.display = graphAdvancedExpanded ? '' : 'none';
				graphAdvancedToggle.setText(graphAdvancedExpanded ? 'Hide' : 'Advanced');
				graphAdvancedToggle.setAttr('aria-expanded', graphAdvancedExpanded ? 'true' : 'false');
				this.plugin.settings.graphRerankAdvancedExpanded = graphAdvancedExpanded;
				await this.plugin.saveSettings();
			})();
		});

		addStyledSlider(
			new Setting(graphAdvancedContainer)
				.setName('Semantic bonus cap')
				.setDesc('Maximum additive boost from non-semantic signals after semantic similarity is computed.'),
			{
				min: 0, max: 1, step: 0.01, value: this.plugin.settings.graphWeightSemantic,
				onChange: async (value) => {
					this.plugin.settings.graphWeightSemantic = value;
					await this.plugin.saveSettings();
				},
				format: (v) => v.toFixed(2)
			}
		);

		addStyledSlider(
			new Setting(graphAdvancedContainer)
				.setName('Backlink distance weight')
				.setDesc('Relative share of additive bonus for notes that are graph-close to the active note.'),
			{
				min: 0, max: 1, step: 0.01, value: this.plugin.settings.graphWeightBacklinkDistance,
				onChange: async (value) => {
					this.plugin.settings.graphWeightBacklinkDistance = value;
					await this.plugin.saveSettings();
				},
				format: (v) => v.toFixed(2)
			}
		);

		addStyledSlider(
			new Setting(graphAdvancedContainer)
				.setName('Recency weight')
				.setDesc('Relative share of additive bonus for recently modified notes.'),
			{
				min: 0, max: 1, step: 0.01, value: this.plugin.settings.graphWeightRecency,
				onChange: async (value) => {
					this.plugin.settings.graphWeightRecency = value;
					await this.plugin.saveSettings();
				},
				format: (v) => v.toFixed(2)
			}
		);

		addStyledSlider(
			new Setting(graphAdvancedContainer)
				.setName('Bookmarked weight')
				.setDesc('Relative share of additive bonus for notes that are bookmarked/starred in Obsidian.'),
			{
				min: 0, max: 1, step: 0.01, value: this.plugin.settings.graphWeightBookmarked,
				onChange: async (value) => {
					this.plugin.settings.graphWeightBookmarked = value;
					await this.plugin.saveSettings();
				},
				format: (v) => v.toFixed(2)
			}
		);

		addStyledSlider(
			new Setting(graphAdvancedContainer)
				.setName('Same-folder weight')
				.setDesc('Relative share of additive bonus for notes sharing folder hierarchy with the active note.'),
			{
				min: 0, max: 1, step: 0.01, value: this.plugin.settings.graphWeightFolderProximity,
				onChange: async (value) => {
					this.plugin.settings.graphWeightFolderProximity = value;
					await this.plugin.saveSettings();
				},
				format: (v) => v.toFixed(2)
			}
		);

		addStyledSlider(
			new Setting(graphAdvancedContainer)
				.setName('Recency half-life (days)')
				.setDesc('How quickly recency impact decays. Higher means slower decay.'),
			{
				min: 1, max: 90, step: 1, value: this.plugin.settings.graphRecencyHalfLifeDays,
				onChange: async (value) => {
					this.plugin.settings.graphRecencyHalfLifeDays = value;
					await this.plugin.saveSettings();
				}
			}
		);


				addStyledSlider(
			new Setting(containerEl)
				.setName('RAG prompt budget per note')
				.setDesc('Percentage of max tokens to use for RAG prompt context (50% = 2000 tokens if max tokens is 4000), recommeded to set lower than overall context percentage to leave room for LLM response'),
			{
				min: 10, max: 80, step: 5, value: this.plugin.settings.searchContextPercentage,
				onChange: async (value) => {
					this.plugin.settings.searchContextPercentage = value;
					await this.plugin.saveSettings();
				},
				format: (v) => v + '%'
			}
		);
		//**************************** */
		// Embedding endpoint setting
		new Setting(containerEl)
			.setName('Embedding API endpoint')
			.setDesc('The endpoint URL for the embedding API (used for generating vector embeddings)')
			.addText(text => text
				.setPlaceholder('http://localhost:1234/v1/embeddings')
				.setValue(this.plugin.settings.embeddingEndpoint)
				.onChange(async (value) => {
					this.plugin.settings.embeddingEndpoint = value;
					await this.plugin.saveSettings();
					this.loadAvailableEmbeddingModels();
				}));
		//**************************** */
		// Embedding model dropdown setting
		const embeddingModelSetting = new Setting(containerEl)
			.setName('Embedding model')
			.setDesc('Select a specific embedding model. (Loaded from LM Studio available models list.)')
			.addDropdown(dropdown => {
				const savedEmbeddingModel = this.plugin.settings.embeddingModel || this.plugin.settings.embeddingModel;
				dropdown.addOption(savedEmbeddingModel, savedEmbeddingModel);
				dropdown.setValue(savedEmbeddingModel);

				dropdown.onChange(async (value) => {
					this.plugin.settings.embeddingModel = value;
					await this.plugin.saveSettings();
				});

				this.embeddingModelDropdown = dropdown;
			});

		embeddingModelSetting.addButton(button => button
			.setButtonText('Refresh Embedding Models')
			.setTooltip('Load available embedding models from LM Studio')
			.onClick(async () => {
				await this.loadAvailableEmbeddingModels();
			}));

		setTimeout(() => {
			this.loadAvailableEmbeddingModels();
		}, 0);

		// Embedding chunking settings
		new Setting(containerEl)
			.setName('Embedding max input tokens')
			.setDesc('Maximum tokens per embedding input. Texts longer than this will be chunked client-side.')
			.addText(text => text
				.setValue(String(this.plugin.settings.embeddingMaxInputTokens ?? 512))
				.setPlaceholder('512')
				.onChange(async (value) => {
					const parsed = parseInt(value || '512', 10) || 512;
					this.plugin.settings.embeddingMaxInputTokens = parsed;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Embedding chunk overlap tokens')
			.setDesc('Number of tokens to overlap between adjacent chunks when chunking long texts.')
			.addText(text => text
				.setValue(String(this.plugin.settings.embeddingChunkOverlapTokens ?? 20))
				.setPlaceholder('20')
				.onChange(async (value) => {
					const parsed = parseInt(value || '20', 10) || 20;
					this.plugin.settings.embeddingChunkOverlapTokens = parsed;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Chunk combine strategy')
			.setDesc('How to combine chunk embeddings when a single-vector result is required')
			.addDropdown(dropdown => {
				dropdown.addOption('storeChunks', 'Store chunks separately (recommended)');
				dropdown.addOption('average', 'Average chunk embeddings');
				dropdown.addOption('first', 'Use first chunk embedding');
				dropdown.setValue(this.plugin.settings.embeddingChunkCombineStrategy || 'storeChunks');
				dropdown.onChange(async (value) => {
					if (value === 'storeChunks' || value === 'average' || value === 'first') {
						this.plugin.settings.embeddingChunkCombineStrategy = value;
					}
					await this.plugin.saveSettings();
				});
			});


		//**************************** */
		// Test embedding connection button
		new Setting(containerEl)
			.setName('Test embedding connection')
			.setDesc('Test if the embedding API endpoint is working correctly')
			.addButton(button => button
				.setButtonText('Test Embedding')
				.setCta()
				.onClick(async () => {
					button.setButtonText('Testing...');
					button.setDisabled(true);

					try {
						// Update the embedding service config with current settings
						this.plugin.ragService.updateEmbeddingConfig({
							endpoint: this.plugin.settings.embeddingEndpoint,
							model: this.plugin.settings.embeddingModel,
							apiKey: this.plugin.settings.apiKey,
							maxInputTokens: this.plugin.settings.embeddingMaxInputTokens,
							chunkOverlapTokens: this.plugin.settings.embeddingChunkOverlapTokens,
							chunkCombineStrategy: this.plugin.settings.embeddingChunkCombineStrategy
						});

						// Test the connection
						const result = await this.plugin.ragService.testEmbeddingConnection();

						if (result.success) {
							new Notice(`Embedding API connection successful. Embedding dimension: ${result.dimensions}`);
						} else {
							new Notice(`Embedding API connection failed: ${result.error}`);
						}
					} catch (error) {
						LoggingUtility.error('Embedding test failed:', error);
						new Notice(`Embedding test failed: ${this.getErrorMessage(error)}`);
					} finally {
						button.setButtonText('Test Embedding');
						button.setDisabled(false);
					}
				}));
	}

	private visualizeSettings_ImageProcessing(containerEl: HTMLElement, LocalLLMSettings: LocalLLMSettings): void
	{
		//**************************** */
		new Setting(containerEl).setName('Image Processing').setHeading();

		// Image text extraction setting
		new Setting(containerEl)
			.setName('Enable image text extraction')
			.setDesc('Extract text from images using vision-capable LLM models and add to the RAG index. Requires a vision model like LLaVA, GPT-4V, or similar.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableImageTextExtraction)
				.onChange(async (value) => {
					this.plugin.settings.enableImageTextExtraction = value;
					await this.plugin.saveSettings();
				}));
		// Add toggle to enable/disable local OCR fallback. This allows users running
		// non-vision models (e.g., llama.cpp) to rely on local OCR (Tesseract) when
		// the LLM cannot process images. Commented so future maintainers understand
		// the purpose of this option.
			new Setting(containerEl)
				.setName('Enable local OCR fallback')
				.setDesc('When enabled, the plugin will run local OCR (Tesseract) if the configured model does not support vision or if the model fails to extract text from the image.')
				.addToggle(toggle => toggle
					.setValue(!!this.plugin.settings.enableLocalOCRFallback)
					.onChange(async (value) => {
						this.plugin.settings.enableLocalOCRFallback = value;
						await this.plugin.saveSettings();
						// Reconfigure extractor if already initialized
						if (this.plugin.ragService) {
							this.plugin.ragService.initializeImageTextExtractor(this.plugin.llmService, this.plugin.settings);
						}
					}));
		//**************************** */
		// Manual image processing button
		new Setting(containerEl)
			.setName('Process images now')
			.setDesc('Manually trigger image text extraction for all images in your vault. This will use your LLM to extract text and add it to the RAG index.')
			.addButton(button => button
				.setButtonText('Process Images')
				.setCta()
				.onClick(async () => {
					button.setButtonText('Processing...');
					button.setDisabled(true);

					try {
						await this.plugin.ragService.processImagesManually((current, total, message) => {
							this.plugin.notifyChatViewsOfRAGProgress(current, total, message);
						});

						// Update stats display
						const newStats = this.plugin.ragService.getStats();
						this.updateStatusDisplay(containerEl, newStats);

						new Notice('Image processing completed successfully!');
					} catch (error) {
						LoggingUtility.error('Image processing failed:', error);
						// Show user-friendly error message for vision model issues
						const errorMessage = this.getErrorMessage(error);
						if (errorMessage.includes('vision capabilities')) {
							new Notice('Vision model required: your current LLM model does not support image processing. Please switch to a vision model like Gemma 4 in LM Studio and try again.', 8000);
						} else {
							new Notice(`Image processing failed: ${errorMessage}`);
						}
					} finally {
						button.setButtonText('Process Images');
						button.setDisabled(false);
					}
				}));

	}

	private visualizeSettings_Debug(containerEl: HTMLElement, LocalLLMSettings: LocalLLMSettings): void
	{
		new Setting(containerEl).setName('Support').setHeading();
		new Setting(containerEl)
			.setName('Research workspace wizard')
			.setDesc('Rerun the first-run setup to scaffold folders and RAG templates in your vault.')
			.addButton(button => button
				.setButtonText('Open wizard')
				.setCta()
				.onClick(() => {
					new FirstRunWizardModal(this.app, this.plugin).open();
				}));
		//**************************** */
		new Setting(containerEl)
			.setName('Review prompt')
			.setDesc('Inject the review prompt into the chat window for testing.')
			.addButton(button => button
				.setButtonText('Show review prompt')
				.setCta()
				.onClick(() => {
					this.plugin.openReviewPromptManually();
				}));
		//**************************** */
		// Add developer logging setting
		new Setting(containerEl)
			.setName('Enable developer logging')
			.setDesc('Enable additional logging for debugging')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableDeveloperLogging)
				.onChange(async (value) => {
					this.plugin.settings.enableDeveloperLogging = value;
					await this.plugin.saveSettings();
				}));
		//**************************** */
		// Add connection test button
		const testButton = containerEl.createEl('button', {
			text: 'Test connection',
			cls: 'mod-cta'
		});

		testButton.addEventListener('click', () => {
			void (async () => {
				testButton.setText('Testing...');
				testButton.disabled = true;

				try {
					// Create a temporary LLM service to test
					const { createLLMService } = await import('@/services/LLMService');
					const llmService = createLLMService({
						apiEndpoint: this.plugin.settings.apiEndpoint,
						apiKey: this.plugin.settings.apiKey,
						maxTokens: this.plugin.settings.maxTokens,
						temperature: this.plugin.settings.temperature,
						systemPrompt: this.plugin.settings.systemPrompt,
						model: this.plugin.settings.model,
						personalityPrompt: this.plugin.settings.personalityPrompt?.[0] ?? '',
						personalityName: this.plugin.settings.personalityName
					});

					// Validate config first
					const validation = llmService.validateConfig();
					if (!validation.valid) {
						throw new Error(`Configuration errors:\n${validation.errors.join('\n')}`);
					}

					// Test connection
					const result = await llmService.testConnection();

					if (result.success) {
						new Notice('Connection successful. Your LLM server is working.');
						testButton.setText('Test connection');
						testButton.disabled = false;
					} else {
						throw new Error(result.error || 'Unknown connection error');
					}
				} catch (error) {
					LoggingUtility.error('Connection test failed:', error);
					new Notice(`Connection failed: ${this.getErrorMessage(error)}`);
					testButton.setText('Test connection');
					testButton.disabled = false;
				}
			})();
		});

		// Add spacing between buttons
		containerEl.createEl('br');
		containerEl.createEl('br');
		//**************************** */
		// Add report problem button
		const reportButton = containerEl.createEl('button', {
			text: 'Report a problem',
			cls: 'mod-cta'
		});
		//**************************** */
			//to do, update this so it shows relevant author information with the plugin version
		// Add version display
		containerEl.createEl('p', { text: `Noesis version ${manifest.version}` })

		reportButton.addEventListener('click', () => {
			window.open('https://github.com/sebastianbrightly/noesis/issues/new', '_blank');
		});
	}

}