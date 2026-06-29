import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, Notice, DropdownComponent, FileSystemAdapter } from 'obsidian';
import { ChatView } from './views/ChatView';
import { LoggingUtility } from './utils/LoggingUtility';
import { RAGService } from './services/RAGService';
import { FirstRunWizardModal } from './views/FirstRunWizard';
import Tesseract from 'tesseract.js';
import '../styles.css';
import manifest from '../manifest.json';
import { ReactView, createPluginRoot } from '@/ReactView';
import React from "react";
import { SettingsPage } from '@/utils/SettingsPage';
import { EditorNativeActionsService } from './services/EditorNativeActionsService';
import { AutoTagService } from './services/AutoTagService';
import { DEFAULT_RESPONSE_NOTE_TEMPLATE } from './utils/TemplateVariableRenderer';



export const CHAT_VIEW_TYPE = 'local-llm-chat-view';


export enum ContextMode {
	CURRENT_NOTE = 'current-note',
	LINKED_NOTES = 'linked-notes',
	CURRENT_FOLDER = 'current-folder',
	DAILY_NOTES = 'daily-notes',
	// Keep legacy stored value for backward compatibility with existing settings.
	BOOKMARKED_NOTES = 'starred-notes',
	SEARCH_QUERY_SCOPE = 'search-query-scope',
	OPEN_NOTES = 'open-notes',
	SEARCH = 'search',
	NONE = 'none'
}

export enum PersonalityMode {
	DEFAULT = 'Default',
	KRISTINA = 'Kristina',
	SAMUEL = 'Samuel',
	LAURA = 'Laura',
	ZION = 'Zion',
	ETHAN = 'Ethan',
	SOPHIA = 'Sophia',
	ADRIAN = 'Adrian'
}

export enum PersonalityTrait {
	DEFAULT = 'Aim to provide unambiguous and epigrammatic responses',
	KRISTINA = 'Professional personal assistant with years of note management experience',
	SAMUEL = 'Warm and friendly project manager, specialied in setting goals',
	LAURA = 'Concise personal assistant with years of experience in research studies',
	ZION = 'Creative thinker with a focus on innovative solutions',
	ETHAN = 'Analytical problem solver with a detail-oriented approach',
	SOPHIA = 'Empathetic listener with strong communication skills, skilled in connecting emotions to personal writing styles',
	ADRIAN = 'Innovative and strategic thinker with a focus on big-picture ideas'
}

export interface AIConnectionConfig {
	id: string;
	name: string;
	isSleeping?: boolean;
	contextMode: ContextMode;
	apiEndpoint: string;
	apiKey?: string;
	model?: string;
	maxTokens: number;
	temperature: number;
}

export interface LocalLLMSettings {
	apiEndpoint: string;
	maxTokens: number;
	temperature: number;
	// System prompt setting
	systemPrompt: string;
	// Model setting (optional - if not set, no model will be sent in payload)
	systemPromptEnabled?: boolean;
	augmentSystemPromptwithPersonality?: boolean;
	personalityName: string;
	personalityPrompt?: string[];
	// Backing store for user-configible personality names and their prompts
	personalityNames?: string[];
	personalityPrompts?: string[];
	storedPersonalitySystemPrompt?: string[];
	model?: string;
	// API key (optional) - if specified, used as a Bearer token (works with LM Studio)
	apiKey?: string;
	// Search settings
	searchMaxResults: number;
	searchContextPercentage: number;
	searchThreshold: number;
	// Context mode setting - updated to remove RAG distinction
	contextMode: ContextMode;
	// Optional query used by search-query scope mode
	scopeQuery?: string;
	// Developer logging setting
	enableDeveloperLogging: boolean;
	// RAG settings (RAG is now always enabled)
	enableRAG: boolean;
	ragThreshold: number;
	ragMaxResults: number;
	graphWeightSemantic: number;
	graphWeightBacklinkDistance: number;
	graphWeightRecency: number;
	graphWeightBookmarked: number;
	graphWeightFolderProximity: number;
	graphRecencyHalfLifeDays: number;
	// Embedding settings
	embeddingEndpoint: string;
	embeddingModel: string;
	// Embedding chunking controls
	embeddingMaxInputTokens?: number;
	embeddingChunkOverlapTokens?: number;
	embeddingChunkCombineStrategy?: 'storeChunks' | 'average' | 'first';
	// Image processing settings
	enableImageTextExtraction: boolean;
	// Whether to enable a local OCR fallback (Tesseract) when the model lacks vision
	// capabilities or the LLM image-processing call fails. This can be toggled
	// by the user in the plugin settings.
	// Exclusion settings for indexing/task processing
	excludedFolders: string[];
	excludedFilePatterns: string[];
	// Context notes visibility setting
	contextNotesVisible: boolean;
	// Review prompt tracking
	usageTimeMs: number;
	lastUsageStartTimestamp: number | null;
	lastReviewPromptTimestamp: number | null;
	reviewLinkClicked: boolean;
	outputPattern: string[];
	enableLocalOCRFallback?: boolean;
	// UI state: header expanded/collapsed
	headerExpanded?: boolean;
	graphRerankAdvancedExpanded?: boolean;

	// Response formatting options (scaffold)
	enableShortResponses: boolean;
	selectedPersonality?: string;
	// First-run onboarding wizard state
	hasCompletedFirstRunWizard?: boolean;
	researchWorkspaceRoot?: string;
	enableResponseNoteTemplate?: boolean;
	responseNoteTemplate?: string;
	autoTagDictionary?: string[];
	autoTagWorkload?: 'small' | 'medium' | 'large';
	autoTagConnectionId?: string;
	multiAIConnections?: AIConnectionConfig[];
	activeAIConnectionId?: string;
}

export const DEFAULT_SETTINGS: LocalLLMSettings = {
	apiEndpoint: 'http://localhost:1234/v1/chat/completions',
	maxTokens: 10000,
	temperature: 0.7,
	// Default system prompt
	systemPrompt: "You are a helpful assistant with access to the user's Obsidian vault. When provided with context from their notes, use that information to provide more accurate and relevant responses. Reference specific notes when appropriate, but focus on answering the user's question clearly and concisely. ",
	systemPromptEnabled: true,
	augmentSystemPromptwithPersonality: false,
	personalityName: PersonalityMode.DEFAULT,
	// Response formatting defaults
	personalityPrompt: [PersonalityTrait.DEFAULT],
	// User-configurable personality lists (used by the settings UI)
	personalityNames: [],
	personalityPrompts: [PersonalityTrait.DEFAULT],
	enableShortResponses: false,
	// Search defaults
	searchMaxResults: 5,
	searchContextPercentage: 50,
	searchThreshold: 0.3,
	// Default context mode (search now uses RAG)
	contextMode: ContextMode.OPEN_NOTES,
	scopeQuery: '',
	// Default developer logging setting
	enableDeveloperLogging: false,
	// RAG defaults (always enabled)
	enableRAG: true,
	ragThreshold: 0.5,
	ragMaxResults: 10,
	graphWeightSemantic: 0.2,
	graphWeightBacklinkDistance: 0.45,
	graphWeightRecency: 0.25,
	graphWeightBookmarked: 0.2,
	graphWeightFolderProximity: 0.1,
	graphRecencyHalfLifeDays: 21,
	// Embedding defaults
	embeddingEndpoint: 'http://localhost:1234/v1/embeddings',
	embeddingModel: 'text-embedding-nomic-embed-text-v1.5',
	embeddingMaxInputTokens: 512,
	embeddingChunkOverlapTokens: 20,
	embeddingChunkCombineStrategy: 'storeChunks',
	// Image processing defaults
	enableImageTextExtraction: true,
	// Default to enabling local OCR fallback so images can still be processed when
	// running models without vision support (e.g., llama.cpp).
	enableLocalOCRFallback: true,
	// Indexing exclusions defaults
	excludedFolders: [],
	excludedFilePatterns: [],
	// Default context notes visibility
	contextNotesVisible: false,
	// Review prompt defaults
	usageTimeMs: 0,
	lastUsageStartTimestamp: null,
	lastReviewPromptTimestamp: null,
	reviewLinkClicked: false,
	outputPattern: []
	,
	selectedPersonality: 'Default',
	graphRerankAdvancedExpanded: false,
	hasCompletedFirstRunWizard: false,
	researchWorkspaceRoot: 'my-research',
	enableResponseNoteTemplate: true,
	responseNoteTemplate: DEFAULT_RESPONSE_NOTE_TEMPLATE,
	autoTagDictionary: [],
	autoTagWorkload: 'medium',
	autoTagConnectionId: undefined,
	multiAIConnections: [],
	activeAIConnectionId: undefined
};
//Should group these as a single object
const REVIEW_PROMPT_THRESHOLD_MS = 60 * 60 * 1000;
const REVIEW_PROMPT_REPEAT_MS = 24 * 60 * 60 * 1000;
const REVIEW_PAGE_URL = 'https://www.obsidianstats.com/plugins/noesis';
const REVIEW_PROMPT_MESSAGE = 'Enjoying Noesis? A quick review helps others discover it';

export default class LocalLLMPlugin extends Plugin {
	settings: LocalLLMSettings;
	ragService: RAGService; 
	public llmService: any; // LLMService instance for image processing
	private usageTrackingIntervalId: number | null = null;
	private reviewPromptPending = false;
	private persistentLogFilePath: string | null = null;
	private editorNativeActionsService: EditorNativeActionsService | null = null;
	private autoTagService: AutoTagService | null = null;

	async onload() {
		this.setupPersistentLogging();
		this.registerGlobalErrorLogging();
		LoggingUtility.initialize();

		await this.loadSettings();
		this.startUsageTracking();

		// Set developer logging based on settings
		LoggingUtility.setDeveloperLoggingEnabled(this.settings.enableDeveloperLogging);

		// Create LLM service for image processing
		const { createLLMService } = await import('./services/LLMService');
		this.llmService = createLLMService({
			apiEndpoint: this.settings.apiEndpoint,
			apiKey: this.settings.apiKey,
			maxTokens: this.settings.maxTokens,
			temperature: this.settings.temperature,
			systemPrompt: this.settings.systemPrompt,
			model: this.settings.model,
			enableShortResponses: this.settings.enableShortResponses,
			augmentSystemPromptwithPersonality: this.settings.augmentSystemPromptwithPersonality,
			personalityPrompt: this.settings.personalityPrompt?.[0] ?? '',
			personalityName: this.settings.personalityName
		});

		this.editorNativeActionsService = new EditorNativeActionsService(this);
		this.editorNativeActionsService.register();

		this.autoTagService = new AutoTagService(this);
		this.autoTagService.register();

		// Initialize RAG service (always enabled with auto-maintenance)
		this.ragService = new RAGService(this.app, this.manifest, {
				endpoint: this.settings.embeddingEndpoint,
				model: this.settings.embeddingModel,
				apiKey: this.settings.apiKey,
				maxInputTokens: this.settings.embeddingMaxInputTokens,
				chunkOverlapTokens: this.settings.embeddingChunkOverlapTokens,
				chunkCombineStrategy: this.settings.embeddingChunkCombineStrategy
		}, {
			autoMaintenance: true,
			backgroundIndexing: true,
			silentMode: false,
			progressCallback: (current, total, message) => {
				this.notifyChatViewsOfRAGProgress(current, total, message);
			},
			completionCallback: () => {
				this.notifyChatViewsOfRAGComplete();
			}
		});

		// Initialize image text extractor in RAG service (pass settings so OCR fallback can be configured)
		this.ragService.initializeImageTextExtractor(this.llmService, this.settings);

		// Defer RAG initialization until layout is ready to ensure vault cache is populated
		this.app.workspace.onLayoutReady(async () => {
			await this.ragService.initialize(this.settings);

			// Always start file watcher since RAG is always enabled
			this.ragService.startFileWatcher();

		});

		// Register the view
		this.registerView(
			CHAT_VIEW_TYPE,
			(leaf) => new ChatView(leaf, this)
		);

		// Add ribbon icon to open chat
		this.addRibbonIcon('sparkles', 'Open Noesis', () => {
			this.activateView();
		});

		// Add command to open chat
		this.addCommand({
			id: 'open-local-llm-chat',
			name: 'Open',
			callback: () => {
				this.activateView();
			}
		});

		this.addCommand({
			id: 'resume-paused-rag-indexing',
			name: 'Resume paused indexing',
			callback: () => {
				if (!this.ragService) {
					new Notice('RAG service is not initialized yet.');
					return;
				}

				const resumed = this.ragService.retryPausedIndexing();
				if (resumed) {
					new Notice('Retry requested. Indexing is resuming.');
				} else {
					new Notice('Indexing is not currently paused.');
				}
			}
		});

		this.addCommand({
			id: 'open-first-run-wizard',
			name: 'Open first-run research wizard',
			callback: () => {
				new FirstRunWizardModal(this.app, this).open();
			}
		});



		this.addSettingTab(new SettingsPage(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			if (!this.settings.hasCompletedFirstRunWizard) {
				new FirstRunWizardModal(this.app, this).open();
			}
		});

	}

	async onunload() {
		LoggingUtility.log('Unloading Noesis Chat plugin');

		await this.flushUsageTracking();

		// Stop RAG file watcher and close database gracefully
		if (this.ragService) {
			await this.ragService.shutdown();
		}

		LoggingUtility.setFileLogger(null);
	}

	private setupPersistentLogging() {
		try {
			if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
				LoggingUtility.setFileLogger(null);
				return;
			}

			const nodeRequire = (window as unknown as { require?: (name: string) => any }).require;
			if (!nodeRequire) {
				LoggingUtility.setFileLogger(null);
				return;
			}

			const fs = nodeRequire('fs');
			const path = nodeRequire('path');

			const vaultPath = this.app.vault.adapter.getBasePath();
			const logDir = path.join(vaultPath, '.obsidian', 'plugins', this.manifest.id, 'logs');
			const logPath = path.join(logDir, 'noesis.log.txt');
			fs.mkdirSync(logDir, { recursive: true });
			this.persistentLogFilePath = logPath;

			LoggingUtility.setFileLogger((line: string) => {
				fs.appendFile(logPath, `${line}\n`, { encoding: 'utf8' }, (error: unknown) => {
					if (error) {
						console.error('Failed to append plugin log file:', error);
					}
				});
			});

			LoggingUtility.error('Persistent plugin logging enabled:', logPath);
		} catch (error) {
			LoggingUtility.setFileLogger(null);
			console.error('Failed to initialize persistent plugin logging:', error);
		}
	}

	private registerGlobalErrorLogging() {
		this.registerDomEvent(window, 'error', (event: ErrorEvent) => {
			LoggingUtility.error('Global error event captured', {
				message: event.message,
				filename: event.filename,
				line: event.lineno,
				column: event.colno,
				error: event.error
			});
		});

		this.registerDomEvent(window, 'unhandledrejection', (event: PromiseRejectionEvent) => {
			LoggingUtility.error('Unhandled promise rejection captured', {
				reason: event.reason
			});
		});

		this.register(() => {
			LoggingUtility.log('Global error logging disposed', this.persistentLogFilePath ?? 'no-file-path');
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		let needsMigrationSave = false;

		const normalizeConnectionConfig = (raw: any): AIConnectionConfig | null => {
			if (!raw || typeof raw !== 'object') {
				return null;
			}

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

			const id = typeof raw.id === 'string' && raw.id.trim().length > 0
				? raw.id.trim()
				: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

			const name = typeof raw.name === 'string' && raw.name.trim().length > 0
				? raw.name.trim()
				: 'External Connection';

			const contextMode = validContextModes.includes(raw.contextMode)
				? raw.contextMode as ContextMode
				: this.settings.contextMode;

			const apiEndpoint = typeof raw.apiEndpoint === 'string' && raw.apiEndpoint.trim().length > 0
				? raw.apiEndpoint.trim()
				: this.settings.apiEndpoint;

			const maxTokens = Number.isFinite(raw.maxTokens)
				? Number(raw.maxTokens)
				: this.settings.maxTokens;

			const temperature = Number.isFinite(raw.temperature)
				? Number(raw.temperature)
				: this.settings.temperature;

			const apiKey = typeof raw.apiKey === 'string' && raw.apiKey.trim().length > 0
				? raw.apiKey.trim()
				: undefined;

			const model = typeof raw.model === 'string' && raw.model.trim().length > 0
				? raw.model.trim()
				: undefined;

			return {
				id,
				name,
				isSleeping: Boolean(raw.isSleeping),
				contextMode,
				apiEndpoint,
				apiKey,
				model,
				maxTokens,
				temperature
			};
		};

		if (typeof this.settings.hasCompletedFirstRunWizard !== 'boolean') {
			this.settings.hasCompletedFirstRunWizard = DEFAULT_SETTINGS.hasCompletedFirstRunWizard;
			needsMigrationSave = true;
		}

		if (typeof this.settings.researchWorkspaceRoot !== 'string' || this.settings.researchWorkspaceRoot.trim().length === 0) {
			this.settings.researchWorkspaceRoot = DEFAULT_SETTINGS.researchWorkspaceRoot;
			needsMigrationSave = true;
		}

		if (typeof this.settings.enableResponseNoteTemplate !== 'boolean') {
			this.settings.enableResponseNoteTemplate = DEFAULT_SETTINGS.enableResponseNoteTemplate;
			needsMigrationSave = true;
		}

		if (typeof this.settings.responseNoteTemplate !== 'string' || this.settings.responseNoteTemplate.trim().length === 0) {
			this.settings.responseNoteTemplate = DEFAULT_SETTINGS.responseNoteTemplate;
			needsMigrationSave = true;
		}

		if (typeof this.settings.scopeQuery !== 'string') {
			this.settings.scopeQuery = DEFAULT_SETTINGS.scopeQuery;
			needsMigrationSave = true;
		}

		if (!Array.isArray(this.settings.autoTagDictionary)) {
			const rawDictionary = (this.settings as any).autoTagDictionary;
			if (typeof rawDictionary === 'string') {
				this.settings.autoTagDictionary = rawDictionary
					.split('\n')
					.map((entry: string) => entry.trim())
					.filter((entry: string) => entry.length > 0);
			} else {
				this.settings.autoTagDictionary = DEFAULT_SETTINGS.autoTagDictionary;
			}
			needsMigrationSave = true;
		}

		if (this.settings.autoTagWorkload !== 'small' && this.settings.autoTagWorkload !== 'medium' && this.settings.autoTagWorkload !== 'large') {
			this.settings.autoTagWorkload = DEFAULT_SETTINGS.autoTagWorkload;
			needsMigrationSave = true;
		}

		const rawConnections = (this.settings as any).multiAIConnections;
		if (!Array.isArray(rawConnections)) {
			this.settings.multiAIConnections = [];
			needsMigrationSave = true;
		} else {
			const normalizedConnections = rawConnections
				.map((conn: any) => normalizeConnectionConfig(conn))
				.filter((conn: AIConnectionConfig | null): conn is AIConnectionConfig => conn !== null);

			if (JSON.stringify(normalizedConnections) !== JSON.stringify(rawConnections)) {
				needsMigrationSave = true;
			}

			this.settings.multiAIConnections = normalizedConnections;
		}

		if (typeof this.settings.activeAIConnectionId !== 'string' || this.settings.activeAIConnectionId.trim().length === 0) {
			if (this.settings.activeAIConnectionId !== undefined) {
				needsMigrationSave = true;
			}
			this.settings.activeAIConnectionId = undefined;
		} else if (!(this.settings.multiAIConnections || []).some(conn => conn.id === this.settings.activeAIConnectionId)) {
			this.settings.activeAIConnectionId = undefined;
			needsMigrationSave = true;
		}

		if (typeof this.settings.autoTagConnectionId !== 'string' || this.settings.autoTagConnectionId.trim().length === 0) {
			if (this.settings.autoTagConnectionId !== undefined) {
				needsMigrationSave = true;
			}
			this.settings.autoTagConnectionId = undefined;
		} else if (!(this.settings.multiAIConnections || []).some(conn => conn.id === this.settings.autoTagConnectionId && !conn.isSleeping)) {
			this.settings.autoTagConnectionId = undefined;
			needsMigrationSave = true;
		}

		// Migrate personalityNames to array if saved as a string or missing
		if (!Array.isArray(this.settings.personalityNames)) {
			const raw = (this.settings as any).personalityNames;
			if (typeof raw === 'string') {
				this.settings.personalityNames = raw.split('\n').map((s: string) => s.trim()).filter((s: string) => s.length > 0);
			} else {
				this.settings.personalityNames = DEFAULT_SETTINGS.personalityNames;
			}
			needsMigrationSave = true;
		}

		if (needsMigrationSave) {
			try {
				await this.saveData(this.settings);
			} catch (e) {
				// ignore
			}
		}
	}

	async saveSettings() {
		if (!Array.isArray(this.settings.multiAIConnections)) {
			this.settings.multiAIConnections = [];
		}

		const activeConnectionIds = new Set(
			(this.settings.multiAIConnections || [])
				.filter(conn => !conn.isSleeping)
				.map(conn => conn.id)
		);

		if (this.settings.activeAIConnectionId && !activeConnectionIds.has(this.settings.activeAIConnectionId)) {
			this.settings.activeAIConnectionId = undefined;
		}

		if (this.settings.autoTagConnectionId && !activeConnectionIds.has(this.settings.autoTagConnectionId)) {
			this.settings.autoTagConnectionId = undefined;
		}

		await this.saveData(this.settings);

		// Update developer logging setting
		LoggingUtility.setDeveloperLoggingEnabled(this.settings.enableDeveloperLogging);

		// Update LLM service config
		if (this.llmService) {
			const { createLLMService } = await import('./services/LLMService');
			this.llmService = createLLMService({
				apiEndpoint: this.settings.apiEndpoint,
				apiKey: this.settings.apiKey,
				maxTokens: this.settings.maxTokens,
				temperature: this.settings.temperature,
				systemPrompt: this.settings.systemPrompt,
				model: this.settings.model,
				enableShortResponses: this.settings.enableShortResponses,
				augmentSystemPromptwithPersonality: this.settings.augmentSystemPromptwithPersonality,
				personalityPrompt: Array.isArray(this.settings.personalityPrompt) ? this.settings.personalityPrompt[0] : this.settings.personalityPrompt,
				personalityName: this.settings.personalityName
			});

			// Re-initialize image text extractor with updated LLM service
			if (this.ragService) {
				this.ragService.initializeImageTextExtractor(this.llmService, this.settings);
			}
		}

		// Update RAG service embedding config
		if (this.ragService) {
			this.ragService.updateEmbeddingConfig({
				endpoint: this.settings.embeddingEndpoint,
				model: this.settings.embeddingModel,
				apiKey: this.settings.apiKey,
				maxInputTokens: this.settings.embeddingMaxInputTokens,
				chunkOverlapTokens: this.settings.embeddingChunkOverlapTokens,
				chunkCombineStrategy: this.settings.embeddingChunkCombineStrategy
			});
		}

		// Notify all open chat views about the settings change
		this.notifyChatViewsOfSettingsChange();
	}

	private startUsageTracking() {
		if (this.settings.lastUsageStartTimestamp === null) {
			this.settings.lastUsageStartTimestamp = Date.now();
		}

		this.usageTrackingIntervalId = window.setInterval(() => {
			void this.updateUsageAndMaybeShowReviewPrompt();
		}, 60 * 1000);
		this.registerInterval(this.usageTrackingIntervalId);

		void this.updateUsageAndMaybeShowReviewPrompt();
	}

	private async updateUsageAndMaybeShowReviewPrompt() {
		const now = Date.now();
		const lastStart = this.settings.lastUsageStartTimestamp;

		if (lastStart !== null && now > lastStart) {
			this.settings.usageTimeMs += now - lastStart;
		}

		this.settings.lastUsageStartTimestamp = now;
		await this.saveData(this.settings);

		if (this.shouldShowReviewPrompt(now)) {
			this.settings.lastReviewPromptTimestamp = now;
			await this.saveData(this.settings);
			this.showReviewPromptInChat();
		}
	}

	private shouldShowReviewPrompt(now: number): boolean {
		if (this.settings.reviewLinkClicked) {
			return false;
		}

		if (this.settings.usageTimeMs < REVIEW_PROMPT_THRESHOLD_MS) {
			return false;
		}

		if (this.settings.lastReviewPromptTimestamp === null) {
			return true;
		}

		return now - this.settings.lastReviewPromptTimestamp >= REVIEW_PROMPT_REPEAT_MS;
	}

	private async flushUsageTracking() {
		const now = Date.now();
		const lastStart = this.settings.lastUsageStartTimestamp;

		if (lastStart !== null && now > lastStart) {
			this.settings.usageTimeMs += now - lastStart;
		}

		this.settings.lastUsageStartTimestamp = null;
		await this.saveData(this.settings);
	}

	private showReviewPromptInChat() {
		const injected = this.notifyChatViewsOfReviewPrompt();
		if (injected) {
			return;
		}

		// Queue for next chat view render and open the chat view for immediate visibility.
		this.reviewPromptPending = true;
		void this.activateView().then(() => {
			const wasInjected = this.notifyChatViewsOfReviewPrompt();
			if (wasInjected) {
				this.reviewPromptPending = false;
			}
		});
	}

	openReviewPromptManually() {
		this.showReviewPromptInChat();
	}

	async markReviewLinkClicked() {
		if (this.settings.reviewLinkClicked) {
			return;
		}

		this.settings.reviewLinkClicked = true;
		this.reviewPromptPending = false;
		await this.saveData(this.settings);
	}

	consumePendingReviewPrompt(chatView: ChatView) {
		if (!this.reviewPromptPending) {
			return;
		}

		chatView.showReviewPromptBanner(REVIEW_PROMPT_MESSAGE, REVIEW_PAGE_URL);
		this.reviewPromptPending = false;
	}

	notifyChatViewsOfSettingsChange() {
		// Get all open chat view leaves
		this.app.workspace.iterateAllLeaves(leaf => {
			// Check if the view is actually a ChatView instance (not a DeferredView)
			// In Obsidian v1.7.2+, views start as DeferredView until they become visible
			if (leaf.view instanceof ChatView) {
				leaf.view.updateContextModeFromSettings();
			}
		});
	}

	/**
	 * Notify all chat views about RAG indexing progress
	 */
	notifyChatViewsOfRAGProgress(current: number, total: number, message: string) {
		const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		leaves.forEach(leaf => {
			const chatView = leaf.view as ChatView;
			if (chatView && typeof chatView.showRAGProgress === 'function') {
				chatView.showRAGProgress(current, total, message);
			}
		});
	}

	/**
	 * Notify all chat views that RAG indexing is complete
	 */
	notifyChatViewsOfRAGComplete() {
		const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		leaves.forEach(leaf => {
			const chatView = leaf.view as ChatView;
			if (chatView && typeof chatView.onRAGIndexingComplete === 'function') {
				chatView.onRAGIndexingComplete();
			}
		});
	}

	private notifyChatViewsOfReviewPrompt(): boolean {
		const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		let injected = false;

		leaves.forEach(leaf => {
			const chatView = leaf.view as ChatView;
			if (chatView && typeof chatView.showReviewPromptBanner === 'function') {
				chatView.showReviewPromptBanner(REVIEW_PROMPT_MESSAGE, REVIEW_PAGE_URL);
				injected = true;
			}
		});

		return injected;
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(CHAT_VIEW_TYPE);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			leaf = leaves[0];
		} else {
			// Create a new leaf in the right sidebar
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({
					type: CHAT_VIEW_TYPE,
					active: true,
				});
			}
		}

		// Reveal the leaf in case it is in a collapsed sidebar
		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}
}
