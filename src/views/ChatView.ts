import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, DropdownComponent, setIcon, TFile } from 'obsidian';
import { LLMService, createLLMService, ChatMessage as LLMChatMessage, StreamCallback } from '../services/LLMService';
import { SearchService, SearchResult } from '../services/SearchService';
import { LoggingUtility } from '../utils/LoggingUtility';
import LocalLLMPlugin, { AIConnectionConfig, ContextMode, PersonalityMode, CHAT_VIEW_TYPE, PersonalityTrait } from '../main';
import { SM_DEFAULT_SETTINGS as SETTINGS_DEFAULTS } from '../services/SettingsManager';

//export const CHAT_VIEW_TYPE = 'local-llm-chat-view';

interface ChatMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	timestamp: Date;
	isStreaming?: boolean;
	usedNotes?: SearchResult[];
	thinkingBlocks?: string[];
}

interface StreamingThinkingState {
	inThinkBlock: boolean;
	buffer: string;
	blocks: string[];
	rawTranscript: string;
}

interface ThinkingViewState {
	expanded: boolean;
	stickToBottom: boolean;
}

interface ThinkingPanelElements {
	statusEl: HTMLElement;
	metaEl: HTMLElement;
	toggleButton: HTMLButtonElement;
	previewEl: HTMLElement;
}

interface LLMConfig {
	apiEndpoint: string;
	maxTokens: number;
	temperature: number;
	systemPrompt?: string;
	model?: string;
	apiKey?: string;
	contextMode?: ContextMode;
}

interface ObsidianApp {
	setting?: {
		open: () => void;
		openTabById: (tabId: string) => void;
	};
}

interface DropdownComponentWithPrivateAPI extends DropdownComponent {
	__component?: {
		setValue: (value: string) => void;
	};
}

export class ChatView extends ItemView {
	private messages: ChatMessage[] = [];
	private messageContainer: HTMLElement;
	private reviewPromptBanner: HTMLElement;
	private inputContainer: HTMLElement;
	private inputElement: HTMLTextAreaElement;
	private sendButton: HTMLButtonElement;
	private stopButton: HTMLButtonElement;
	private searchIndicator: HTMLElement;
	private ragStatusArea: HTMLElement;
	private ragStatusContent: HTMLElement;
	private llmService: LLMService;
	private searchService: SearchService;
	private isStreaming: boolean = false;
	private currentAbortController: AbortController | null = null;
	private contextMode: ContextMode = ContextMode.OPEN_NOTES;
	private scopeQueryInput?: HTMLInputElement;
	private connectionDropdown?: DropdownComponentWithPrivateAPI;
	private connectionContainer?: HTMLElement;


	public plugin: LocalLLMPlugin;

	private personalityDropdown?: DropdownComponentWithPrivateAPI;
	private streamingThinkingState = new Map<string, StreamingThinkingState>();
	private thinkingViewState = new Map<string, ThinkingViewState>();
	private streamingRenderInFlight = new Set<string>();
	private pendingStreamingRender = new Map<string, ChatMessage>();

	// UI element for inline summary preview (created in onOpen)
	private summaryPreviewContainer?: HTMLElement;
	// Last conversation text used for summarization (for resubmit)
	private lastConversationForSummary?: string;

	constructor(leaf: WorkspaceLeaf, plugin: LocalLLMPlugin) {
		super(leaf);
		this.plugin = plugin;
		// Pass RAG service to SearchService for enhanced search capabilities
		this.searchService = new SearchService(this.app, plugin.ragService, () => ({
			graphWeightSemantic: this.plugin.settings.graphWeightSemantic,
			graphWeightBacklinkDistance: this.plugin.settings.graphWeightBacklinkDistance,
			graphWeightRecency: this.plugin.settings.graphWeightRecency,
			graphWeightBookmarked: this.plugin.settings.graphWeightBookmarked,
			graphWeightFolderProximity: this.plugin.settings.graphWeightFolderProximity,
			graphRecencyHalfLifeDays: this.plugin.settings.graphRecencyHalfLifeDays,
			enableDeveloperLogging: this.plugin.settings.enableDeveloperLogging
		}));
		// Initialize with plugin settings
		this.updateLLMServiceFromSettings();
		// Initialize context mode from plugin settings
		this.contextMode = this.plugin.settings.contextMode;
		LoggingUtility.log('ChatView initialized with context mode:', this.contextMode);
	}

	/**
	 * Public getter for other views to check whether this chat view is currently streaming.
	 */
	public getIsStreaming(): boolean {
		return this.isStreaming;
	}


	getViewType(): string {
		return CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Noesis';
	}

	getIcon(): string {
		return 'sparkles';
	}

	async onOpen() 
	{
		LoggingUtility.log('Opening ChatView with settings:', this.plugin.settings);
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('local-llm-full-height');

		// Header with title and settings button
		const header = container.createEl('div', { cls: 'local-llm-chat-header' });
		header.createEl('h4', { text: 'Noesis chat' });

		// Apply persisted header expanded/collapsed state (if any)
		// This uses the `headerExpanded` flag stored in plugin settings so
		// the UI remembers the user's preference across sessions.
		const initialHeaderExpanded = !!this.plugin.settings.headerExpanded;
		if (initialHeaderExpanded) {
			header.addClass('expanded');
		} else {
			header.addClass('collapsed');
		}

		// Create button container for header buttons
		const headerButtons = header.createEl('div', { cls: 'local-llm-header-buttons' });

		// Add a small toggle button to expand/collapse the header.
		// We place it in the header buttons area so it appears next to other controls.
		const headerToggle = headerButtons.createEl('button', {
			cls: 'local-llm-header-toggle',
			attr: { 'type': 'button' },
			text: initialHeaderExpanded ? 'Collapse' : 'Expand'
		});

		// Reflect initial expanded state for accessibility
		headerToggle.setAttribute('aria-expanded', initialHeaderExpanded ? 'true' : 'false');

		headerToggle.addEventListener('click', async (e) => {
			e.preventDefault();
			const nowExpanded = !header.hasClass('expanded');
			if (nowExpanded) {
				header.addClass('expanded');
				header.removeClass('collapsed');
				headerToggle.textContent = 'Collapse';
			} else {
				header.removeClass('expanded');
				header.addClass('collapsed');
				headerToggle.textContent = 'Expand';
			}

			// Update aria attribute so assistive tech knows current state
			headerToggle.setAttribute('aria-expanded', nowExpanded ? 'true' : 'false');

			// Persist the new state in plugin settings
			this.plugin.settings.headerExpanded = nowExpanded;
			try {
				await this.plugin.saveSettings();
			} catch (err) {
				LoggingUtility.error('Failed to save headerExpanded setting:', err);
			}
		});

		// Create new chat button
		const newChatButton = headerButtons.createEl('button', {
			cls: 'local-llm-new-chat-button',
			text: 'New chat',
			attr: { 'aria-label': 'Start new chat', 'type': 'button' }
		});
		newChatButton.addEventListener('click', async () => {
			await this.startNewChat();
		});

		// Create copy conversation button (copies the whole conversation to clipboard)
		const copyConvButton = headerButtons.createEl('button', {
			cls: 'local-llm-copy-conversation-button',
			attr: { 'aria-label': 'Copy conversation', 'type': 'button' }
		});
		setIcon(copyConvButton, 'clipboard');
		copyConvButton.addEventListener('click', async () => {
			await this.copyEntireConversation();
		});

		// Summarize and save button - shows inline preview then allows saving
		const summarizeButton = headerButtons.createEl('button', {
			cls: 'local-llm-summarize-save-button',
			attr: { 'aria-label': 'Summarize and save conversation', 'type': 'button' }
		});
		setIcon(summarizeButton, 'document');
		summarizeButton.addEventListener('click', async () => {
			summarizeButton.disabled = true;
			try {
				const conv = this.getConversationText();
				this.lastConversationForSummary = conv;
				const prompt = `Summarize the following conversation into a concise Obsidian markdown note. Provide a short title (one line) starting with '# ' followed by a brief summary and 3-6 bullet points of key takeaways. Keep total length under 250 words.\n\nConversation:\n${conv}`;
				this.showSummaryPreview('Generating summary preview...');
				const summary = await this.llmService.sendMessage(prompt);
				this.showSummaryPreview(summary);
			} catch (err) {
				LoggingUtility.error('Error summarizing conversation:', err);
				new Notice('❌ Failed to summarize conversation');
			} finally {
				summarizeButton.disabled = false;
			}
		});

		// Create context mode dropdown
		const contextModeContainer = headerButtons.createEl('div', {
			cls: 'local-llm-context-mode-container'
		});

		contextModeContainer.createEl('label', {
			cls: 'local-llm-context-mode-label',
			text: 'Context:'
		});

		const dropdown = new DropdownComponent(contextModeContainer)
			.addOption(ContextMode.CURRENT_NOTE, 'Current Note')
			.addOption(ContextMode.LINKED_NOTES, 'Linked Notes')
			.addOption(ContextMode.CURRENT_FOLDER, 'Current Folder')
			.addOption(ContextMode.DAILY_NOTES, 'Daily Notes')
			.addOption(ContextMode.BOOKMARKED_NOTES, 'Bookmarked Notes')
			.addOption(ContextMode.SEARCH_QUERY_SCOPE, 'Search Query Scope')
			.addOption(ContextMode.OPEN_NOTES, 'Open Tabs')
			.addOption(ContextMode.SEARCH, 'All Notes')
			.addOption(ContextMode.NONE, 'None')
			.onChange(async (value) => {
				this.contextMode = value as ContextMode;
				// Save to default settings or selected connection profile
				const activeConnection = this.getActiveConnection();
				if (activeConnection) {
					activeConnection.contextMode = this.contextMode;
				} else {
					this.plugin.settings.contextMode = this.contextMode;
				}
				await this.plugin.saveSettings();
				this.updateScopeQueryInputVisibility();
				// Update RAG status display
				this.updateRAGStatus();
			});

		// Set initial value based on plugin settings
		dropdown.setValue(this.contextMode);
		this.applyActiveConnectionContextModeToUI();

		this.scopeQueryInput = contextModeContainer.createEl('input', {
			cls: 'local-llm-context-scope-input',
			attr: {
				type: 'text',
				placeholder: 'scope query (folder/topic/tag)'
			}
		});
		this.scopeQueryInput.value = this.plugin.settings.scopeQuery || '';
		this.scopeQueryInput.addEventListener('change', async () => {
			if (!this.scopeQueryInput) {
				return;
			}

			this.plugin.settings.scopeQuery = this.scopeQueryInput.value.trim();
			await this.plugin.saveSettings();
		});
		this.updateScopeQueryInputVisibility();

		// Create personality selector populated from stored personality names
		const PersonalityContainer = headerButtons.createEl('div', {
			cls: 'local-llm-personality-container'
		});

		PersonalityContainer.createEl('label', {
			cls: 'local-llm-personality-label',
			text: 'Personality:'
		});

		const PersonalityDropdown = new DropdownComponent(PersonalityContainer);
		this.personalityDropdown = PersonalityDropdown as DropdownComponentWithPrivateAPI;
		// Coerce stored names to array or fall back to defaults
		let names: string[] = [];
		const rawNames = Object.keys(PersonalityMode);
		if (Array.isArray(rawNames)) {
			names = rawNames;
		} else {
			names =  ['Friendly', 'Formal', 'Casual', 'Professional', 'Sarcastic', 'Custom'];
		}
		// Add Auto option
		PersonalityDropdown.addOption('', 'Auto');
		if (names.length > 0) {
			names.forEach(n => PersonalityDropdown.addOption(n, n));
		} else {
			( ['Friendly', 'Formal', 'Casual', 'Professional', 'Sarcastic', 'Custom']).forEach(n => PersonalityDropdown.addOption(n, n));
		}

		const currentpersonality = this.plugin.settings.personalityName || '';
		PersonalityDropdown.setValue(currentpersonality);

		PersonalityDropdown.onChange(async (value) => {
			this.plugin.settings.selectedPersonality = value === '' ? undefined : value;
			this.plugin.settings.personalityName = value;
			await this.plugin.saveSettings();

			// Notify other views so UI updates immediately
			if (typeof this.plugin.notifyChatViewsOfSettingsChange === 'function') {
				this.plugin.notifyChatViewsOfSettingsChange();
			}

			// Apply immediately to the LLM service used by this view
			this.updateLLMServiceFromSettings();
			// If user selected Custom, open settings to edit the custom prompt
			if (value === 'Custom') {
				this.openPluginSettingsPage();
			}
		});

		// Ensure personality dropdown reflects any later settings changes
		this.updatePersonalityDropdownFromSettings();
		this.ensureConnectionSelectorOptions();

		// Create settings button
		const settingsButton = headerButtons.createEl('button', {
			cls: 'local-llm-settings-button',
			attr: { 'aria-label': 'Open plugin settings', 'type': 'button' },
			text: '⚙'
		});

		settingsButton.addEventListener('click', () => {
			this.openPluginSettingsPage();
		});

		this.connectionContainer = headerButtons.createEl('div', {
			cls: 'local-llm-connection-container'
		});

		this.connectionContainer.createEl('label', {
			cls: 'local-llm-connection-label',
			text: 'Connection:'
		});

		const connectionDropdown = new DropdownComponent(this.connectionContainer);
		this.connectionDropdown = connectionDropdown as DropdownComponentWithPrivateAPI;
		connectionDropdown.onChange(async (value) => {
			this.plugin.settings.activeAIConnectionId = value === '' ? undefined : value;
			await this.plugin.saveSettings();
			this.applyActiveConnectionContextModeToUI();
			this.updateLLMServiceFromSettings();
			this.updateRAGStatus();
		});
		this.ensureConnectionSelectorOptions();
		LoggingUtility.log('Header with controls created');
		// Create main chat container with flexbox layout
		const chatContainer = container.createEl('div', { cls: 'local-llm-chat-container' });

		// Inline summary preview container (hidden until needed)
		// Place it inside the chat container so it matches the chat width
		this.summaryPreviewContainer = chatContainer.createEl('div', {
			cls: 'local-llm-summary-preview local-llm-summary-preview-hidden'
		});

		// Create message container (scrollable area)
		this.messageContainer = chatContainer.createEl('div', {
			cls: 'local-llm-messages'
		});

		// Create inline review prompt area (hidden by default).
		this.reviewPromptBanner = chatContainer.createEl('div', {
			cls: 'local-llm-review-prompt local-llm-review-prompt-hidden'
		});

		// Create input container (fixed at bottom)
		this.inputContainer = chatContainer.createEl('div', {
			cls: 'local-llm-input-container'
		});

		// Create search indicator
		this.searchIndicator = this.inputContainer.createEl('div', {
			cls: 'local-llm-search-indicator local-llm-search-indicator-hidden',
			text: '🔍 Searching vault...'
		});

		// Create input element
		this.inputElement = this.inputContainer.createEl('textarea', {
			placeholder: 'Ask a question...',
			cls: 'local-llm-input'
		});

		// Create send button
		this.sendButton = this.inputContainer.createEl('button', {
			text: 'Send',
			cls: 'local-llm-send-button'
		});

		// Create stop button
		this.stopButton = this.inputContainer.createEl('button', {
			text: 'Stop',
			cls: 'local-llm-stop-button'
		});

		// Create RAG status area below input container
		this.ragStatusArea = chatContainer.createEl('div', {
			cls: 'local-llm-rag-status-area local-llm-rag-status-hidden'
		});

		this.ragStatusContent = this.ragStatusArea.createEl('div', {
			cls: 'local-llm-rag-status-content'
		});

		// Add event listeners
		this.inputElement.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this.sendMessage();
			}
		});

		this.sendButton.addEventListener('click', () => {
			this.sendMessage();
		});

		this.stopButton.addEventListener('click', () => {
			this.stopStreaming();
		});

		// Add initial welcome message
		await this.addMessage({
			id: 'welcome',
			role: 'assistant',
			content: await ChatView.getWelcomeMessage(this.llmService),
			timestamp: new Date()
		});

		// Check and display initial RAG status
		this.updateRAGStatus();

		// Keep scope/status text in sync as the user changes active notes/leaves.
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
			this.updateRAGStatus();
		}));
		this.registerEvent(this.app.workspace.on('file-open', () => {
			this.updateRAGStatus();
		}));

		if (typeof this.plugin.consumePendingReviewPrompt === 'function') {
			this.plugin.consumePendingReviewPrompt(this);
		}
	}

	async onClose() {
		return;
	}

	// Method to update LLM service from plugin settings
	updateLLMServiceFromSettings() {
		const settings = this.plugin.settings;
		const activeConnection = this.getActiveConnection();
		const resolvedConfig: LLMConfig = {
			apiEndpoint: activeConnection?.apiEndpoint || settings.apiEndpoint,
			maxTokens: activeConnection?.maxTokens ?? settings.maxTokens,
			temperature: activeConnection?.temperature ?? settings.temperature,
			systemPrompt: settings.systemPrompt,
			model: activeConnection?.model ?? settings.model,
			apiKey: activeConnection?.apiKey ?? settings.apiKey,
			contextMode: activeConnection?.contextMode ?? settings.contextMode
		};

		this.contextMode = resolvedConfig.contextMode || settings.contextMode;
		LoggingUtility.log('Updating LLM service with settings:', settings);
		this.llmService = createLLMService({
			apiEndpoint: resolvedConfig.apiEndpoint,
			maxTokens: resolvedConfig.maxTokens,
			temperature: resolvedConfig.temperature,
			systemPrompt: resolvedConfig.systemPrompt,
			model: resolvedConfig.model,
			apiKey: resolvedConfig.apiKey,
			enableShortResponses: settings.enableShortResponses,
			storedPersonalitySystemPrompt: settings.storedPersonalitySystemPrompt,
			IdentityName: settings.storedPersonalitySystemPrompt ? 'IdentityName' : undefined,
			personalityName: settings.personalityName,
		});
		this.applyActiveConnectionContextModeToUI();
	}

	/**
	 * Update context mode from settings
	 */
	updateContextModeFromSettings(): void {
		this.contextMode = this.getEffectiveContextMode();
		// Update dropdown to reflect new value
		const dropdown = this.containerEl.querySelector('.local-llm-context-mode-container select') as HTMLSelectElement;
		if (dropdown) {
			dropdown.value = this.contextMode;
		}
		// Update RAG status display
		this.updateRAGStatus();

		// Update personality dropdown to reflect any changed personality names or selected personality
		this.updatePersonalityDropdownFromSettings();
		this.ensureConnectionSelectorOptions();
	}

	private getConnectionList(): AIConnectionConfig[] {
		if (!Array.isArray(this.plugin.settings.multiAIConnections)) {
			return [];
		}

		return this.plugin.settings.multiAIConnections.filter(connection => !connection.isSleeping);
	}

	private getActiveConnection(): AIConnectionConfig | undefined {
		const activeId = this.plugin.settings.activeAIConnectionId;
		if (!activeId) {
			return undefined;
		}

		return this.getConnectionList().find(connection => connection.id === activeId);
	}

	private getEffectiveContextMode(): ContextMode {
		return this.getActiveConnection()?.contextMode || this.plugin.settings.contextMode;
	}

	private applyActiveConnectionContextModeToUI(): void {
		const dropdown = this.containerEl.querySelector('.local-llm-context-mode-container select') as HTMLSelectElement;
		this.contextMode = this.getEffectiveContextMode();
		if (dropdown && dropdown.value !== this.contextMode) {
			dropdown.value = this.contextMode;
		}
	}

	private ensureConnectionSelectorOptions(): void {
		if (!this.connectionDropdown || !this.connectionContainer) {
			return;
		}

		const connections = this.getConnectionList();
		this.connectionDropdown.selectEl.innerHTML = '';
		this.connectionDropdown.addOption('', 'Default');
		connections.forEach(connection => {
			const label = connection.name?.trim().length ? connection.name.trim() : connection.id;
			this.connectionDropdown?.addOption(connection.id, label);
		});

		const activeId = this.plugin.settings.activeAIConnectionId;
		if (activeId && connections.some(connection => connection.id === activeId)) {
			this.connectionDropdown.setValue(activeId);
		} else {
			this.connectionDropdown.setValue('');
			this.plugin.settings.activeAIConnectionId = undefined;
		}

		if (connections.length > 0) {
			this.connectionContainer.removeClass('local-llm-connection-hidden');
		} else {
			this.connectionContainer.addClass('local-llm-connection-hidden');
		}
	}

	/**
	 * Rebuilds the personality dropdown options from plugin settings and applies current selection
	 */
	updatePersonalityDropdownFromSettings(): void {
		if (!this.personalityDropdown) return;

		const dd = this.personalityDropdown;
		// Clear existing options
		if (dd.selectEl) {
			dd.selectEl.innerHTML = '';
		}

		// Add Auto option
		dd.addOption('', 'Auto');

		const names = PersonalityMode && Object.keys(PersonalityMode).length > 0
			? Object.keys(PersonalityMode)
			: ['Friendly', 'Formal', 'Casual', 'Professional', 'Sarcastic', 'Custom'];

		names.forEach(n => dd.addOption(n, n));

		// Restore selected value
		try {
			dd.setValue(this.plugin.settings.selectedPersonality || '');
		} catch (e) {
			// ignore if setValue fails
		}
	}

	updateLLMService(config: LLMConfig) {
		LoggingUtility.log('Updating LLM service with config:', config);
		this.llmService = createLLMService({
			apiEndpoint: config.apiEndpoint,
			maxTokens: config.maxTokens,
			temperature: config.temperature,
			systemPrompt: config.systemPrompt,
			model: config.model,
			apiKey: config.apiKey,
			enableShortResponses: (config as any).enableShortResponses,
			storedPersonalitySystemPrompt: this.plugin.settings.storedPersonalitySystemPrompt,
			personalityName: this.plugin.settings.personalityName
		});
	}

	/**
	 * Open Obsidian settings directly to this plugin's settings tab.
	 */
	private openPluginSettingsPage(): void {
		const settingTab = (this.app as unknown as ObsidianApp).setting;
		if (!settingTab) {
			new Notice('Unable to open settings.');
			return;
		}

		const pluginTabId = this.plugin.manifest.id;
		settingTab.open();
		settingTab.openTabById(pluginTabId);

		// Some Obsidian builds need a short defer after opening settings.
		window.setTimeout(() => {
			try {
				settingTab.openTabById(pluginTabId);
			} catch (error) {
				LoggingUtility.error('Failed to focus plugin settings tab:', error);
			}
		}, 0);
	}

	showReviewPromptBanner(message: string, reviewUrl: string): void {
		this.reviewPromptBanner.empty();
		this.reviewPromptBanner.removeClass('local-llm-review-prompt-hidden');
		this.reviewPromptBanner.addClass('local-llm-review-prompt-visible');

		const textEl = this.reviewPromptBanner.createEl('span', {
			cls: 'local-llm-review-prompt-text',
			text: message
		});
		textEl.setAttribute('role', 'status');

		const actionContainer = this.reviewPromptBanner.createEl('div', {
			cls: 'local-llm-review-prompt-actions'
		});

		const reviewButton = actionContainer.createEl('button', {
			text: 'Leave a review',
			cls: 'mod-cta',
			attr: { type: 'button' }
		});
		reviewButton.addEventListener('click', async () => {
			if (typeof this.plugin.markReviewLinkClicked === 'function') {
				await this.plugin.markReviewLinkClicked();
			}
			window.open(reviewUrl, '_blank');
			this.reviewPromptBanner.empty();
			this.reviewPromptBanner.removeClass('local-llm-review-prompt-visible');
			this.reviewPromptBanner.addClass('local-llm-review-prompt-hidden');
		});

		const dismissButton = actionContainer.createEl('button', {
			text: 'Dismiss',
			attr: { type: 'button' }
		});
		dismissButton.addEventListener('click', () => {
			this.reviewPromptBanner.empty();
			this.reviewPromptBanner.removeClass('local-llm-review-prompt-visible');
			this.reviewPromptBanner.addClass('local-llm-review-prompt-hidden');
		});
	}

	private async sendMessage() {
		const content = this.inputElement.value.trim();
		if (!content) return;

		// If already streaming, queue this message or handle it differently
		if (this.isStreaming) {
			LoggingUtility.log('Already streaming, but allowing new message to be sent');
			// We'll allow sending multiple messages, but we need to handle this properly
		}

		// Update LLM service with current settings before sending
		this.updateLLMServiceFromSettings();

		// Add user message
		const userMessage: ChatMessage = {
			id: Date.now().toString(),
			role: 'user',
			content: content,
			timestamp: new Date()
		};

		await this.addMessage(userMessage);
		this.inputElement.value = '';

		// Create abort controller for this request
		this.currentAbortController = new AbortController();

		// Keep input enabled but disable send button while streaming
		this.setSendButtonEnabled(false);
		this.showStopButton(true);
		this.isStreaming = true;

		// Get context based on dropdown selection
		let searchContext = '';
		let searchResults: SearchResult[] = [];
		let contextTokenBudget = Math.floor(this.plugin.settings.maxTokens * (this.plugin.settings.searchContextPercentage / 100));

		let contextMode: ContextMode = this.contextMode;
		this.showSearchIndicator(true);
		try {
			if (contextMode === ContextMode.CURRENT_NOTE) {
				const currentNoteContext = await this.searchService.getActiveNoteContext();
				if (currentNoteContext.length > 0) {
					searchResults = currentNoteContext;
					searchContext = this.searchService.formatSearchResults(searchResults, contextTokenBudget);
					LoggingUtility.log(`Using current note context (${currentNoteContext[0].path})`);
				}
			} else if (contextMode === ContextMode.LINKED_NOTES) {
				const linkedFiles = await this.searchService.getLinkedNotesFiles();
				if (linkedFiles.length > 0) {
					const maxContextTokens = Math.max(120, contextTokenBudget);
					searchResults = await this.searchService.searchVaultInFiles(content, linkedFiles, {
						maxResults: this.plugin.settings.ragMaxResults,
						maxTokens: maxContextTokens,
						threshold: this.plugin.settings.ragThreshold
					});

					if (searchResults.length > 0) {
						searchContext = this.searchService.formatSearchResults(searchResults, maxContextTokens);
						LoggingUtility.log(`Using ${searchResults.length} relevant linked notes from ${linkedFiles.length} scoped files`);
					} else {
						LoggingUtility.log(`No linked notes met relevance threshold (${this.plugin.settings.ragThreshold})`);
					}
				}
			} else if (contextMode === ContextMode.CURRENT_FOLDER) {
				const currentFolderFiles = await this.searchService.getCurrentFolderFiles();
				if (currentFolderFiles.length > 0) {
					const maxContextTokens = Math.max(120, contextTokenBudget);
					searchResults = await this.searchService.searchVaultInFiles(content, currentFolderFiles, {
						maxResults: this.plugin.settings.ragMaxResults,
						maxTokens: maxContextTokens,
						threshold: this.plugin.settings.ragThreshold
					});

					if (searchResults.length > 0) {
						searchContext = this.searchService.formatSearchResults(searchResults, maxContextTokens);
						LoggingUtility.log(`Using ${searchResults.length} relevant notes from current folder scope (${currentFolderFiles.length} files)`);
					} else {
						LoggingUtility.log(`No current-folder notes met relevance threshold (${this.plugin.settings.ragThreshold})`);
					}
				}
			} else if (contextMode === ContextMode.DAILY_NOTES) {
				const dailyNoteFiles = await this.searchService.getDailyNotesFiles();
				if (dailyNoteFiles.length > 0) {
					const maxContextTokens = Math.max(120, contextTokenBudget);
					searchResults = await this.searchService.searchVaultInFiles(content, dailyNoteFiles, {
						maxResults: this.plugin.settings.ragMaxResults,
						maxTokens: maxContextTokens,
						threshold: this.plugin.settings.ragThreshold
					});

					if (searchResults.length > 0) {
						searchContext = this.searchService.formatSearchResults(searchResults, maxContextTokens);
						LoggingUtility.log(`Using ${searchResults.length} relevant daily notes from ${dailyNoteFiles.length} scoped files`);
					} else {
						LoggingUtility.log(`No daily notes met relevance threshold (${this.plugin.settings.ragThreshold})`);
					}
				}
			} else if (contextMode === ContextMode.BOOKMARKED_NOTES) {
				const bookmarkedFiles = await this.searchService.getBookmarkedMarkdownFiles();
				if (bookmarkedFiles.length > 0) {
					const maxContextTokens = Math.max(120, contextTokenBudget);
					searchResults = await this.searchService.searchVaultInFiles(content, bookmarkedFiles, {
						maxResults: this.plugin.settings.ragMaxResults,
						maxTokens: maxContextTokens,
						threshold: this.plugin.settings.ragThreshold
					});

					if (searchResults.length > 0) {
						searchContext = this.searchService.formatSearchResults(searchResults, maxContextTokens);
						LoggingUtility.log(`Using ${searchResults.length} relevant bookmarked notes as context`);
					} else {
						LoggingUtility.log(`No bookmarked notes met relevance threshold (${this.plugin.settings.ragThreshold})`);
					}
				}
			} else if (contextMode === ContextMode.SEARCH_QUERY_SCOPE) {
				const typedScopeQuery = this.scopeQueryInput?.value.trim() || this.plugin.settings.scopeQuery?.trim() || '';
				const effectiveScopeQuery = typedScopeQuery.length > 0 ? typedScopeQuery : content;

				if (!typedScopeQuery) {
					new Notice('Scope query was empty; using your message as the scope filter.');
				}

				const scopeFiles = await this.searchService.getFilesForScopeQuery(effectiveScopeQuery, 80);
				if (scopeFiles.length > 0) {
					const maxContextTokens = Math.max(120, contextTokenBudget);
					searchResults = await this.searchService.searchVaultInFiles(content, scopeFiles, {
						maxResults: this.plugin.settings.ragMaxResults,
						maxTokens: maxContextTokens,
						threshold: this.plugin.settings.ragThreshold
					});

					if (searchResults.length > 0) {
						searchContext = this.searchService.formatSearchResults(searchResults, maxContextTokens);
						LoggingUtility.log(`Using scoped query context from ${scopeFiles.length} candidate files`);
					}
				} else {
					new Notice('No notes matched the scope query. Try broader keywords.');
				}
			} else if (contextMode === ContextMode.OPEN_NOTES) {
				// Use open tabs as context
				const openTabs = await this.searchService.getCurrentNoteContext();
				if (openTabs.length > 0) {
					searchResults = openTabs;
					searchContext = this.searchService.formatSearchResults(searchResults, contextTokenBudget);
					LoggingUtility.log(`Using ${openTabs.length} open tabs as context`);
				} else {
					LoggingUtility.log('No open tabs found, no context will be used');
				}
			} else if (contextMode === ContextMode.SEARCH) {
				// Search entire vault using RAG (with keyword fallback)
				const maxContextTokens = Math.max(120, contextTokenBudget);
				contextTokenBudget = maxContextTokens;
				searchResults = await this.searchService.searchVault(content, {
					maxResults: this.plugin.settings.ragMaxResults,
					maxTokens: maxContextTokens,
					threshold: this.plugin.settings.ragThreshold
				});

				if (searchResults.length > 0) {
					searchContext = this.searchService.formatSearchResults(searchResults, maxContextTokens);
					LoggingUtility.log(`Found ${searchResults.length} relevant notes using enhanced search`);
				}
			} else if (contextMode === ContextMode.NONE) {
				// No context - just use the user's message as-is
				LoggingUtility.log('No context mode selected - using message without additional context');
			}
		} catch (searchError) {
			LoggingUtility.error('Error getting context:', searchError);
			// Continue without search context if search fails
		} finally {
			this.showSearchIndicator(false);
		}

		// Create streaming assistant message
		const assistantMessage: ChatMessage = {
			id: 'streaming-' + Date.now(),
			role: 'assistant',
			content: '',
			timestamp: new Date(),
			isStreaming: true,
			usedNotes: searchResults.length > 0 ? searchResults : undefined
		};

		await this.addMessage(assistantMessage);

		try {
			// Convert chat history to LLM format
			const conversationHistory: LLMChatMessage[] = this.messages
				.filter(m => !m.isStreaming && m.id !== 'welcome')
				.map(m => ({
					role: m.role,
					content: m.content
				}));



			// Add search context to the user message if available
			// Build optional style prefix from settings (scaffold)
			const settings = this.plugin.settings;
			let stylePrefix = '';
			if (settings.enableShortResponses) {
				stylePrefix += 'Please be concise and provide a short answer. ';
			}
			// If a selected personality exists, prefer any matching stored personality prompt
			const selected = settings.personalityName && (settings.personalityName as string).trim();
			if (selected) {
				const prompts = [PersonalityTrait[selected.toUpperCase() as keyof typeof PersonalityTrait] || ''];

				if (prompts && prompts[0]) {
					stylePrefix += `Your name is ${selected}. `;
					stylePrefix += `${prompts[0]} `;
				} else {
					// fallback to legacy brief tone instruction
					stylePrefix += `Professional tone. `;
				}
			}

			let enhancedContent = content;
			if (searchContext) {
				enhancedContent = `Context from your Obsidian vault:\n${searchContext}\n\nUser question: ${content}`;
			}

			if (stylePrefix) {
				enhancedContent = `${stylePrefix}\n\n${enhancedContent}`;
			}

			// Create streaming callback
			const streamCallback: StreamCallback = async (chunk: string, isComplete: boolean) => {
				if (isComplete) {
					// Finalize the message
					await this.finalizeStreamingMessage(assistantMessage.id);
					this.isStreaming = false;
					this.setSendButtonEnabled(true);
					this.showStopButton(false);
					this.currentAbortController = null;
				} else {
					// Update the streaming message
					await this.updateStreamingMessage(assistantMessage.id, chunk);
				}
			};

			// Call streaming LLM API with abort signal
			await this.llmService.sendMessageStream(enhancedContent, conversationHistory, streamCallback, this.currentAbortController.signal);

		} catch (error) {
			// Handle error
			if ((error as any).name === 'AbortError') {
				// User cancelled - don't change the message content
				this.isStreaming = false;
				this.setSendButtonEnabled(true);
				this.showStopButton(false);
				this.currentAbortController = null;

				// Finalize the current streaming message as-is
				const streamingMessage = this.messages.find(m => m.isStreaming);
				if (streamingMessage) {
					streamingMessage.isStreaming = false;
					this.finalizeStreamingMessage(streamingMessage.id);
				}
			} else {
				// Handle actual errors
				this.handleStreamingError(assistantMessage.id, error as Error);
				this.isStreaming = false;
				this.setSendButtonEnabled(true);
				this.showStopButton(false);
				this.currentAbortController = null;
			}
		}
	}

	private setInputEnabled(enabled: boolean) {
		this.inputElement.disabled = !enabled;
		this.sendButton.disabled = !enabled;

		if (enabled) {
			this.inputElement.focus();
		}
	}

	private setSendButtonEnabled(enabled: boolean) {
		this.sendButton.disabled = !enabled;

		if (enabled) {
			this.inputElement.focus();
		}
	}

	private showStopButton(show: boolean) {
		if (show) {
			this.stopButton.removeClass('local-llm-stop-button-hidden');
			this.stopButton.addClass('local-llm-stop-button-visible');
			this.sendButton.removeClass('local-llm-send-button-visible');
			this.sendButton.addClass('local-llm-send-button-hidden');
		} else {
			this.stopButton.removeClass('local-llm-stop-button-visible');
			this.stopButton.addClass('local-llm-stop-button-hidden');
			this.sendButton.removeClass('local-llm-send-button-hidden');
			this.sendButton.addClass('local-llm-send-button-visible');
		}
	}

	private showSearchIndicator(show: boolean) {
		if (show) {
			this.searchIndicator.removeClass('local-llm-search-indicator-hidden');
			this.searchIndicator.addClass('local-llm-search-indicator-visible');
		} else {
			this.searchIndicator.removeClass('local-llm-search-indicator-visible');
			this.searchIndicator.addClass('local-llm-search-indicator-hidden');
		}
	}

	private async updateStreamingMessage(messageId: string, chunk: string) {
		const message = this.messages.find(m => m.id === messageId);
		if (!message) {
			return;
		}

		const state = this.getOrCreateStreamingThinkingState(messageId);
		const normalizedChunk = this.normalizeStreamingChunk(state, chunk);
		if (!normalizedChunk) {
			return;
		}

		const assistantDelta = this.extractAssistantContentFromChunk(state, normalizedChunk);
		if (assistantDelta.length > 0) {
			message.content += assistantDelta;
		}
		message.thinkingBlocks = state.blocks.length > 0 ? [...state.blocks] : undefined;

		// Update the content directly instead of re-rendering the full message shell.
		await this.updateStreamingContent(messageId, message);
	}

	private async updateStreamingContent(messageId: string, message: ChatMessage) {
		this.pendingStreamingRender.set(messageId, message);
		if (this.streamingRenderInFlight.has(messageId)) {
			return;
		}

		this.streamingRenderInFlight.add(messageId);
		try {
			while (true) {
				const nextMessage = this.pendingStreamingRender.get(messageId);
				if (!nextMessage) {
					break;
				}
				this.pendingStreamingRender.delete(messageId);

				const messageElement = this.messageContainer.querySelector(`[data-message-id="${messageId}"]`);
				if (!messageElement) {
					break;
				}

				const contentEl = messageElement.querySelector('.local-llm-message-content') as HTMLElement | null;
				if (!contentEl) {
					break;
				}

				await this.renderAssistantMessageContent(contentEl, nextMessage);
				this.messageContainer.scrollTop = this.messageContainer.scrollHeight;
			}
		} finally {
			this.streamingRenderInFlight.delete(messageId);
		}
	}

	private async finalizeStreamingMessage(messageId: string) {
		const message = this.messages.find(m => m.id === messageId);
		if (message) {
			this.flushStreamingThinkingState(message);
			message.isStreaming = false;
			const viewState = this.getOrCreateThinkingViewState(message);
			viewState.expanded = false;
			// Remove the existing message element and re-render with markdown
			const messageElement = this.messageContainer.querySelector(`[data-message-id="${messageId}"]`);
			if (messageElement) {
				messageElement.remove();
			}
			await this.renderMessage(message);
		}
	}

	private getOrCreateStreamingThinkingState(messageId: string): StreamingThinkingState {
		const existing = this.streamingThinkingState.get(messageId);
		if (existing) {
			return existing;
		}

		const created: StreamingThinkingState = {
			inThinkBlock: false,
			buffer: '',
			blocks: [],
			rawTranscript: ''
		};
		this.streamingThinkingState.set(messageId, created);
		return created;
	}

	/**
	 * Some providers send cumulative chunks instead of deltas.
	 * Normalize to true delta text so we don't duplicate thinking/output.
	 */
	private normalizeStreamingChunk(state: StreamingThinkingState, chunk: string): string {
		if (!chunk) {
			return '';
		}

		if (state.rawTranscript && chunk.length > state.rawTranscript.length && chunk.startsWith(state.rawTranscript)) {
			const delta = chunk.slice(state.rawTranscript.length);
			state.rawTranscript = chunk;
			return delta;
		}

		state.rawTranscript += chunk;
		return chunk;
	}

	private extractAssistantContentFromChunk(state: StreamingThinkingState, chunk: string): string {
		if (!chunk) {
			return '';
		}

		const openTag = '<think>';
		const closeTag = '</think>';
		const assistantParts: string[] = [];
		let input = state.buffer + chunk;
		state.buffer = '';

		while (input.length > 0) {
			if (!state.inThinkBlock) {
				const openIndex = input.toLowerCase().indexOf(openTag);
				if (openIndex === -1) {
					const carry = this.getTrailingTagPrefix(input, openTag);
					const safeLength = input.length - carry.length;
					if (safeLength > 0) {
						assistantParts.push(input.slice(0, safeLength));
					}
					state.buffer = carry;
					break;
				}

				if (openIndex > 0) {
					assistantParts.push(input.slice(0, openIndex));
				}

				state.inThinkBlock = true;
				state.blocks.push('');
				input = input.slice(openIndex + openTag.length);
				continue;
			}

			const closeIndex = input.toLowerCase().indexOf(closeTag);
			if (closeIndex === -1) {
				const carry = this.getTrailingTagPrefix(input, closeTag);
				const safeLength = input.length - carry.length;
				if (safeLength > 0) {
					this.appendToThinkingBlock(state, input.slice(0, safeLength));
				}
				state.buffer = carry;
				break;
			}

			if (closeIndex > 0) {
				this.appendToThinkingBlock(state, input.slice(0, closeIndex));
			}

			state.inThinkBlock = false;
			input = input.slice(closeIndex + closeTag.length);
		}

		return assistantParts.join('');
	}

	private flushStreamingThinkingState(message: ChatMessage): void {
		const state = this.streamingThinkingState.get(message.id);
		if (!state) {
			return;
		}

		if (state.buffer.length > 0) {
			if (state.inThinkBlock) {
				this.appendToThinkingBlock(state, state.buffer);
			} else {
				message.content += state.buffer;
			}
		}

		state.buffer = '';
		state.inThinkBlock = false;
		message.thinkingBlocks = state.blocks.length > 0 ? [...state.blocks] : undefined;
		this.streamingThinkingState.delete(message.id);
	}

	private appendToThinkingBlock(state: StreamingThinkingState, value: string): void {
		if (!value) {
			return;
		}

		if (state.blocks.length === 0) {
			state.blocks.push(value);
			return;
		}

		const lastIndex = state.blocks.length - 1;
		state.blocks[lastIndex] = `${state.blocks[lastIndex]}${value}`;
	}

	private getTrailingTagPrefix(value: string, tag: string): string {
		const maxLength = Math.min(value.length, tag.length - 1);
		const valueLower = value.toLowerCase();
		const tagLower = tag.toLowerCase();

		for (let prefixLength = maxLength; prefixLength > 0; prefixLength--) {
			if (valueLower.endsWith(tagLower.slice(0, prefixLength))) {
				return value.slice(value.length - prefixLength);
			}
		}

		return '';
	}

	private async renderAssistantMessageContent(contentEl: HTMLElement, message: ChatMessage): Promise<void> {
		await this.renderAssistantResponse(contentEl, message);
		await this.renderThinkingSection(contentEl, message);
		this.renderInlineCitations(contentEl, message);
		contentEl.addClass('local-llm-selectable-content');
	}

	private renderInlineCitations(contentEl: HTMLElement, message: ChatMessage): void {
		const existing = contentEl.querySelector('.local-llm-inline-citations') as HTMLElement | null;
		if (existing) {
			existing.remove();
		}

		if (message.isStreaming || !message.usedNotes || message.usedNotes.length === 0) {
			return;
		}

		const deduplicatedNotes = this.deduplicateNotesByPath(message.usedNotes).slice(0, 6);
		if (deduplicatedNotes.length === 0) {
			return;
		}

		const citationsEl = contentEl.createEl('div', {
			cls: 'local-llm-inline-citations'
		});
		citationsEl.createEl('div', {
			cls: 'local-llm-inline-citations-title',
			text: 'Sources'
		});

		const listEl = citationsEl.createEl('ol', {
			cls: 'local-llm-inline-citations-list'
		});

		deduplicatedNotes.forEach((note, index) => {
			const itemEl = listEl.createEl('li', {
				cls: 'local-llm-inline-citations-item'
			});
			const linkTarget = note.anchorTarget ? `${note.path}${note.anchorTarget}` : note.path;
			const linkEl = itemEl.createEl('a', {
				cls: 'local-llm-inline-citations-link',
				text: `[${index + 1}] ${note.title}`,
				attr: { href: '#', role: 'button' }
			});
			linkEl.addEventListener('click', (event) => {
				event.preventDefault();
				this.app.workspace.openLinkText(linkTarget, '', true);
			});

			itemEl.createEl('span', {
				cls: 'local-llm-inline-citations-path',
				text: ` (${linkTarget})`
			});
		});
	}

	private async renderAssistantResponse(contentEl: HTMLElement, message: ChatMessage): Promise<void> {
		let responseEl = contentEl.querySelector('.local-llm-assistant-response') as HTMLElement | null;
		if (!responseEl) {
			responseEl = contentEl.createEl('div', {
				cls: 'local-llm-assistant-response'
			});
		}

		responseEl.empty();
		await MarkdownRenderer.render(
			this.app,
			message.content,
			responseEl,
			'',
			this
		);

		if (message.isStreaming) {
			responseEl.createEl('span', {
				cls: 'streaming-cursor',
				text: '▋'
			});
		}

		const thinkingContainer = contentEl.querySelector('.local-llm-thinking-container') as HTMLElement | null;
		if (thinkingContainer && responseEl.nextSibling !== thinkingContainer) {
			contentEl.insertBefore(responseEl, thinkingContainer);
		}
	}

	private getOrCreateThinkingViewState(message: ChatMessage): ThinkingViewState {
		const existing = this.thinkingViewState.get(message.id);
		if (existing) {
			return existing;
		}

		const created: ThinkingViewState = {
			expanded: !!message.isStreaming,
			stickToBottom: true
		};
		this.thinkingViewState.set(message.id, created);
		return created;
	}

	private isThinkingPreviewNearBottom(previewEl: HTMLElement): boolean {
		const distanceFromBottom = previewEl.scrollHeight - previewEl.clientHeight - previewEl.scrollTop;
		return distanceFromBottom <= 24;
	}

	private getOrCreateThinkingPanelElements(contentEl: HTMLElement, messageId: string): ThinkingPanelElements {
		let containerEl = contentEl.querySelector('.local-llm-thinking-container') as HTMLElement | null;
		if (!containerEl) {
			containerEl = contentEl.createEl('div', {
				cls: 'local-llm-thinking-container'
			});
		}

		let summaryRow = containerEl.querySelector('.local-llm-thinking-summary') as HTMLElement | null;
		if (!summaryRow) {
			summaryRow = containerEl.createEl('div', {
				cls: 'local-llm-thinking-summary'
			});
		}

		let statusEl = summaryRow.querySelector('.local-llm-thinking-status') as HTMLElement | null;
		if (!statusEl) {
			statusEl = summaryRow.createEl('span', {
				cls: 'local-llm-thinking-status'
			});
		}

		let summaryControls = summaryRow.querySelector('.local-llm-thinking-controls') as HTMLElement | null;
		if (!summaryControls) {
			summaryControls = summaryRow.createEl('div', {
				cls: 'local-llm-thinking-controls'
			});
		}

		let metaEl = summaryControls.querySelector('.local-llm-thinking-meta') as HTMLElement | null;
		if (!metaEl) {
			metaEl = summaryControls.createEl('span', {
				cls: 'local-llm-thinking-meta'
			});
		}

		let toggleButton = summaryControls.querySelector('.local-llm-thinking-toggle') as HTMLButtonElement | null;
		if (!toggleButton) {
			toggleButton = summaryControls.createEl('button', {
				cls: 'local-llm-thinking-toggle',
				attr: { type: 'button' }
			});
		}

		let previewEl = containerEl.querySelector('.local-llm-thinking-preview-markdown') as HTMLElement | null;
		if (!previewEl) {
			previewEl = containerEl.createEl('div', {
				cls: 'local-llm-thinking-preview-markdown'
			});
		}

		if (toggleButton.dataset.boundMessageId !== messageId) {
			toggleButton.dataset.boundMessageId = messageId;
			toggleButton.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.handleThinkingPanelToggle(messageId);
			});
		}

		if (previewEl.dataset.scrollBound !== 'true') {
			previewEl.dataset.scrollBound = 'true';
			previewEl.addEventListener('scroll', () => {
				const message = this.messages.find(m => m.id === messageId);
				if (!message) {
					return;
				}

				const state = this.getOrCreateThinkingViewState(message);
				state.stickToBottom = this.isThinkingPreviewNearBottom(previewEl as HTMLElement);
			});
		}

		return {
			statusEl,
			metaEl,
			toggleButton,
			previewEl
		};
	}

	private setThinkingPanelExpanded(elements: ThinkingPanelElements, expanded: boolean): void {
		elements.toggleButton.textContent = expanded ? 'Hide' : 'Show';
		if (expanded) {
			elements.previewEl.removeClass('local-llm-thinking-preview-hidden');
		} else {
			elements.previewEl.addClass('local-llm-thinking-preview-hidden');
		}
	}

	private handleThinkingPanelToggle(messageId: string): void {
		const message = this.messages.find(m => m.id === messageId);
		if (!message) {
			return;
		}

		const state = this.getOrCreateThinkingViewState(message);
		state.expanded = !state.expanded;

		const messageElement = this.messageContainer.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
		const contentEl = messageElement?.querySelector('.local-llm-message-content') as HTMLElement | null;
		if (!contentEl) {
			return;
		}

		const panel = this.getOrCreateThinkingPanelElements(contentEl, messageId);
		this.setThinkingPanelExpanded(panel, state.expanded);

		if (state.expanded && state.stickToBottom) {
			panel.previewEl.scrollTop = panel.previewEl.scrollHeight;
		}
	}

	private async renderThinkingSection(contentEl: HTMLElement, message: ChatMessage): Promise<void> {
		const blocks = message.thinkingBlocks || [];
		const streamState = this.streamingThinkingState.get(message.id);
		const isThinkingActive = !!message.isStreaming && !!streamState?.inThinkBlock;
		if (blocks.length === 0 && !isThinkingActive) {
			const existingContainer = contentEl.querySelector('.local-llm-thinking-container') as HTMLElement | null;
			if (existingContainer) {
				existingContainer.remove();
			}
			this.thinkingViewState.delete(message.id);
			return;
		}

		const thinkingLines = this.getThinkingLines(blocks);
		const totalCharacters = blocks.reduce((sum, block) => sum + block.length, 0);
		const state = this.getOrCreateThinkingViewState(message);
		const panel = this.getOrCreateThinkingPanelElements(contentEl, message.id);
		const previousScrollTop = panel.previewEl.scrollTop;

		if (state.expanded) {
			state.stickToBottom = this.isThinkingPreviewNearBottom(panel.previewEl);
		}

		panel.statusEl.textContent = isThinkingActive ? 'Thinking...' : 'Thought process';
		panel.metaEl.textContent = `${totalCharacters.toLocaleString()} chars`;
		this.setThinkingPanelExpanded(panel, state.expanded);

		panel.previewEl.empty();
		for (const line of thinkingLines) {
			const lineEl = panel.previewEl.createEl('div', {
				cls: 'local-llm-thinking-preview-line'
			});
			await MarkdownRenderer.render(
				this.app,
				line,
				lineEl,
				'',
				this
			);
		}

		if (!state.expanded) {
			return;
		}

		if (state.stickToBottom) {
			panel.previewEl.scrollTop = panel.previewEl.scrollHeight;
			return;
		}

		panel.previewEl.scrollTop = Math.min(
			previousScrollTop,
			Math.max(0, panel.previewEl.scrollHeight - panel.previewEl.clientHeight)
		);
	}

	private getThinkingLines(blocks: string[]): string[] {
		if (blocks.length === 0) {
			return ['Analyzing...'];
		}

		const lines = blocks
			.join('\n')
			.replace(/\r/g, '')
			.split('\n')
			.map(line => line.trim())
			.filter(line => line.length > 0);

		if (lines.length === 0) {
			return ['Analyzing...'];
		}

		return lines;
	}

	private handleStreamingError(messageId: string, error: Error) {
		const message = this.messages.find(m => m.id === messageId);
		if (message) {
			message.content = error.message;
			message.isStreaming = false;
			message.thinkingBlocks = undefined;
			this.streamingThinkingState.delete(messageId);
			this.thinkingViewState.delete(messageId);
			this.pendingStreamingRender.delete(messageId);
			this.streamingRenderInFlight.delete(messageId);
			// Remove the existing message element and re-render
			const messageElement = this.messageContainer.querySelector(`[data-message-id="${messageId}"]`);
			if (messageElement) {
				messageElement.remove();
			}
			this.renderMessage(message);
		}
		LoggingUtility.error('Error calling local LLM:', error);
	}

	private async addMessage(message: ChatMessage): Promise<void> {
		this.messages.push(message);
		await this.renderMessage(message);
	}

	private removeMessage(messageId: string) {
		const messageElement = this.messageContainer.querySelector(`[data-message-id="${messageId}"]`);
		if (messageElement) {
			messageElement.remove();
		}
		this.messages = this.messages.filter(m => m.id !== messageId);
		this.streamingThinkingState.delete(messageId);
		this.thinkingViewState.delete(messageId);
		this.pendingStreamingRender.delete(messageId);
		this.streamingRenderInFlight.delete(messageId);
	}

	private async renderMessage(message: ChatMessage) {
		const messageEl = this.messageContainer.createEl('div', {
			cls: `local-llm-message local-llm-message-${message.role}`,
			attr: { 'data-message-id': message.id }
		});

		const contentEl = messageEl.createEl('div', {
			cls: 'local-llm-message-content'
		});

		// Render markdown for assistant messages, plain text for user messages.
		if (message.role === 'assistant') {
			await this.renderAssistantMessageContent(contentEl, message);

			// Add refresh button for installation messages (welcome messages with installation instructions)
			if (!message.isStreaming && message.id === 'welcome' && message.content.includes('Welcome to Noesis!')) {
				const refreshButton = messageEl.createEl('button', {
					cls: 'local-llm-refresh-button',
					text: '🔄 Test connection',
					attr: { 'aria-label': 'Test connection to LLM server', 'type': 'button' }
				});

				refreshButton.addEventListener('click', async () => {
					// Show loading state
					refreshButton.textContent = '🔄 Testing...';
					refreshButton.disabled = true;

					try {
						// Update LLM service with current settings
						this.updateLLMServiceFromSettings();

						// Test connection
						const testResult = await this.llmService.testConnection();

						if (testResult.success) {
							// Connection successful - update the welcome message
							const welcomeMessage = this.messages.find(m => m.id === 'welcome');
							if (welcomeMessage) {
								welcomeMessage.content = 'What\'s on your mind?';
								// Re-render the message
								this.messageContainer.empty();
								for (const msg of this.messages) {
									await this.renderMessage(msg);
								}
							}
							new Notice('✅ Connection successful! You can now start chatting.', 3000);
						} else {
							// Connection failed
							new Notice('❌ Connection failed. Please check your server settings.', 3000);
							refreshButton.textContent = '🔄 Test connection';
							refreshButton.disabled = false;
						}
					} catch (error) {
						LoggingUtility.error('Error testing connection:', error);
						new Notice('❌ Connection failed. Please check your server settings.', 3000);
						refreshButton.textContent = '🔄 Test connection';
						refreshButton.disabled = false;
					}
				});
			}
		} else {
			// Plain text for user messages
			contentEl.setText(message.content);
		}

		// Add copy button for all non-streaming messages (both user and assistant)
		if (!message.isStreaming) {
			const copyButton = messageEl.createEl('button', {
				cls: 'local-llm-copy-button',
				attr: { 'aria-label': 'Copy message content', 'type': 'button' }
			});
			setIcon(copyButton, 'copy');

			copyButton.addEventListener('click', async () => {
				await navigator.clipboard.writeText(message.content);

				// Show success feedback
				setIcon(copyButton, 'check');
				copyButton.classList.add('copied');

				setTimeout(() => {
					setIcon(copyButton, 'copy');
					copyButton.classList.remove('copied');
				}, 1000);
			});
		}

		// Show used notes information for assistant messages
		if (message.role === 'assistant' && message.usedNotes && message.usedNotes.length > 0) {
			// Deduplicate notes by path, keeping only the highest relevance score for each unique document
			const deduplicatedNotes = this.deduplicateNotesByPath(message.usedNotes);

			const notesInfoEl = messageEl.createEl('div', {
				cls: 'local-llm-used-notes'
			});

			const notesHeader = notesInfoEl.createEl('div', {
				cls: 'local-llm-used-notes-header'
			});

			// Create header text
			const headerText = notesHeader.createEl('span', {
				text: `📚 Used ${deduplicatedNotes.length} note${deduplicatedNotes.length > 1 ? 's' : ''} as context:`
			});

			// Create toggle link
			const toggleLink = notesHeader.createEl('a', {
				cls: 'local-llm-context-toggle',
				text: this.plugin.settings.contextNotesVisible ? 'Hide' : 'Show'
			});

			// Add click handler for toggle
			toggleLink.addEventListener('click', async (e) => {
				e.preventDefault();
				const currentVisibility = this.plugin.settings.contextNotesVisible;
				const newVisibility = !currentVisibility;

				// Update setting
				this.plugin.settings.contextNotesVisible = newVisibility;
				await this.plugin.saveSettings();

				// Update toggle text
				toggleLink.textContent = newVisibility ? 'Hide' : 'Show';

				// Show/hide notes list
				if (newVisibility) {
					notesList.removeClass('local-llm-used-notes-list-hidden');
				} else {
					notesList.addClass('local-llm-used-notes-list-hidden');
				}
			});

			const notesList = notesInfoEl.createEl('div', {
				cls: `local-llm-used-notes-list ${this.plugin.settings.contextNotesVisible ? '' : 'local-llm-used-notes-list-hidden'}`
			});

			deduplicatedNotes.forEach(note => {
				const noteEl = notesList.createEl('div', {
					cls: 'local-llm-used-note-item'
				});

				const noteTitle = noteEl.createEl('span', {
					cls: 'local-llm-used-note-title',
					text: note.title
				});

				const notePath = noteEl.createEl('span', {
					cls: 'local-llm-used-note-path',
					text: ` (${note.path}${note.anchorTarget ?? ''})`
				});

				if (note.headingPath) {
					noteEl.createEl('span', {
						cls: 'local-llm-used-note-path',
						text: ` [${note.headingPath}]`
					});
				}

				const noteRelevance = noteEl.createEl('span', {
					cls: 'local-llm-used-note-relevance',
					text: ` - ${(note.relevance * 100).toFixed(1)}% relevant`
				});

				// Make the note clickable to open it
				noteEl.addClass('local-llm-note-clickable');
				noteEl.addEventListener('click', () => {
					const jumpTarget = note.anchorTarget ? `${note.path}${note.anchorTarget}` : note.path;
					this.app.workspace.openLinkText(jumpTarget, '', true);
				});

				if (this.plugin.settings.enableDeveloperLogging && note.graphDebug) {
					const debug = note.graphDebug;
					noteEl.createEl('div', {
						cls: 'local-llm-used-note-debug',
						text: `debug final=${debug.normalizedScore.toFixed(3)} sem=${debug.semantic.toFixed(3)} link=${debug.backlinkDistanceScore.toFixed(3)} recency=${debug.recencyScore.toFixed(3)} bookmarked=${debug.bookmarkedScore.toFixed(3)} folder=${debug.folderScore.toFixed(3)} dist=${debug.backlinkDistanceRaw ?? '∞'} days=${debug.daysSinceModified.toFixed(1)}`
					});
				}
			});

			if (this.plugin.settings.enableDeveloperLogging) {
				const debugPanel = notesInfoEl.createEl('details', {
					cls: 'local-llm-used-notes-debug-panel'
				});
				const summary = debugPanel.createEl('summary', {
					text: 'Debug: ranking and anchors'
				});
				summary.addClass('local-llm-used-notes-debug-summary');

				const pre = debugPanel.createEl('pre', {
					cls: 'local-llm-used-notes-debug-json'
				});
				const payload = deduplicatedNotes.map(note => ({
					title: note.title,
					path: note.path,
					anchorTarget: note.anchorTarget,
					headingPath: note.headingPath,
					relevance: note.relevance,
					graphDebug: note.graphDebug
				}));
				pre.textContent = JSON.stringify(payload, null, 2);
			}
		}

		const timestampEl = messageEl.createEl('div', {
			cls: 'local-llm-message-timestamp'
		});

		timestampEl.setText(message.timestamp.toLocaleTimeString());

		// Scroll to bottom
		this.messageContainer.scrollTop = this.messageContainer.scrollHeight;
	}

	/**
	 * Deduplicate search results by document path, keeping only the highest relevance score for each unique document.
	 * Assumes input is already sorted by relevance (highest first).
	 */
	private deduplicateNotesByPath(notes: SearchResult[]): SearchResult[] {
		const seenPaths = new Set<string>();

		return notes.filter((note) => {
			const key = `${note.path}::${note.anchorTarget ?? note.paragraphIndex ?? 'file'}`;
			if (seenPaths.has(key)) {
				return false;
			}
			seenPaths.add(key);
			return true;
		});
	}

	private stopStreaming() {
		if (this.currentAbortController) {
			this.currentAbortController.abort();
		}
		this.isStreaming = false;
		this.setSendButtonEnabled(true);
		this.showStopButton(false);
		this.currentAbortController = null;

		// Finalize the current streaming message as-is
		const streamingMessage = this.messages.find(m => m.isStreaming);
		if (streamingMessage) {
			streamingMessage.isStreaming = false;
			// Re-render the message to remove the streaming cursor and apply markdown
			this.finalizeStreamingMessage(streamingMessage.id);
		}
	}

	private async startNewChat() {
		// Stop any ongoing streaming
		if (this.isStreaming) {
			this.stopStreaming();
		}

		// Clear all messages
		this.messages = [];
		this.messageContainer.empty();
		this.streamingThinkingState.clear();
		this.thinkingViewState.clear();
		this.pendingStreamingRender.clear();
		this.streamingRenderInFlight.clear();

		// Add new welcome message
		await this.addMessage({
			id: 'welcome',
			role: 'assistant',
			content: await ChatView.getWelcomeMessage(this.llmService),
			timestamp: new Date()
		});

		// Clear input field
		this.inputElement.value = '';
		this.inputElement.focus();
	}

	private copyEntireConversation() {
		// Filter out welcome message and format conversation
		const conversationMessages = this.messages
			.filter(m => m.id !== 'welcome')
			.map(m => {
				const timestamp = m.timestamp.toLocaleString();
				const role = m.role === 'user' ? 'You' : 'Assistant';
				return `[${timestamp}] ${role}:\n${m.content}\n`;
			});

		const conversationText = conversationMessages.join('\n---\n\n');

        // Copy to clipboard
        navigator.clipboard.writeText(conversationText).then(() => {
            new Notice('✅ Conversation copied to clipboard!', 2000);
        });
	}

	private getConversationText(): string {
		const conversationMessages = this.messages
			.filter(m => m.id !== 'welcome')
			.map(m => {
				const timestamp = m.timestamp.toLocaleString();
				const role = m.role === 'user' ? 'You' : 'Assistant';
				return `[${timestamp}] ${role}:\n${m.content}\n`;
			});

		return conversationMessages.join('\n---\n\n');
	}

	private static async getWelcomeMessage(llmService: LLMService): Promise<string> {
		// Test the connection
		const testResult = await llmService.testConnection();

		if (testResult.success) {
			return `What's on your mind?`;
		} else {
			return `## 🚀 Welcome to Noesis!

It looks like your local LLM server isn't running yet. Here's how to get started:

### Getting Started

1. **Download and Install LM Studio** from [lmstudio.ai](https://lmstudio.ai)
3. **Download a model** 
   * We recommend:
	   * \`Gemma 4 E4B\` (recommended)
	   * \`Gemma 4 E2B\`
	   * Select the largest parameter size that LM Studio says can fit on your GPU
4. **Load the model** in LM Studio
   * Once the model is downloaded, select the model in the top center toolbar to load it
   * **IMPORTANT**: *Do not load more than one LLM model at a time, it will cause connection failed errors*
5. **Start the local server**:
- Click the "Developer" tab on the left
- Click Settings:
   - Make sure "CORS" is enabled
   - Ensure the default port number 1234 is used
- In the Status box in the top left
   - Click the radio button to start the server

Once your server is running, click the test connection button below.`;
		}
	}

	/**
	 * Update the RAG status area based on current state
	 */
	private updateRAGStatus(): void {
		// Check if currently indexing
		if (this.plugin.ragService && this.plugin.ragService.isCurrentlyIndexing) {
			// Will be updated by progress callbacks, don't show stats
			return;
		}

		// Show database stats when using retrieval-backed modes.
		if (this.usesRetrievalBackedContext()) {
			const stats = this.plugin.ragService.getStats();
			const scopeDescription = this.getActiveScopeDescription();
			this.showRAGStats(stats.documentCount, stats.fileCount, scopeDescription);
		} else {
			this.hideRAGStatus();
		}
	}

	private getActiveScopeDescription(): string | null {
		if (this.contextMode !== ContextMode.CURRENT_FOLDER) {
			return null;
		}

		const folderPath = this.searchService.getCurrentFolderScopePath();
		if (!folderPath) {
			return 'Current Folder scope: No active markdown file';
		}

		return `Current Folder scope: ${folderPath}`;
	}

	private usesRetrievalBackedContext(): boolean {
		return this.contextMode === ContextMode.SEARCH ||
			this.contextMode === ContextMode.SEARCH_QUERY_SCOPE ||
			this.contextMode === ContextMode.LINKED_NOTES ||
			this.contextMode === ContextMode.CURRENT_FOLDER ||
			this.contextMode === ContextMode.DAILY_NOTES ||
			this.contextMode === ContextMode.BOOKMARKED_NOTES;
	}

	private updateScopeQueryInputVisibility(): void {
		if (!this.scopeQueryInput) {
			return;
		}

		const shouldShow = this.contextMode === ContextMode.SEARCH_QUERY_SCOPE;
		if (shouldShow) {
			this.scopeQueryInput.removeClass('local-llm-context-scope-input-hidden');
		} else {
			this.scopeQueryInput.addClass('local-llm-context-scope-input-hidden');
		}
	}

	/**
	 * Show RAG database statistics
	 */
	private showRAGStats(documentCount: number, fileCount: number, scopeDescription?: string | null): void {
		this.ragStatusContent.empty();
		const statsEl = this.ragStatusContent.createEl('div', { cls: 'local-llm-rag-stats' });
		statsEl.createEl('span', { cls: 'local-llm-rag-stats-icon', text: '📚' });
		statsEl.createEl('span', {
			cls: 'local-llm-rag-stats-text',
			text: `RAG Database: ${documentCount.toLocaleString()} paragraphs from ${fileCount.toLocaleString()} files available for context`
		});

		if (scopeDescription) {
			this.ragStatusContent.createEl('div', {
				cls: 'local-llm-rag-stats-scope',
				text: scopeDescription
			});
		}

		this.ragStatusArea.removeClass('local-llm-rag-status-paused');
		this.ragStatusArea.removeClass('local-llm-rag-status-hidden');
		this.ragStatusArea.addClass('local-llm-rag-status-visible');
	}

	/**
	 * Show RAG indexing progress
	 */
	showRAGProgress(current: number, total: number, message: string): void {
		const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
		const isPaused = this.plugin.ragService.isIndexingPaused || message.toLowerCase().includes('indexing paused');
		const isAutoRetrying = message.toLowerCase().includes('retrying automatically') || message.toLowerCase().includes('connection issue detected');
		const showForceStop = isPaused || isAutoRetrying;
		const pauseMessage = this.plugin.ragService.pauseMessage;
		const resolvedMessage = isPaused && pauseMessage ? pauseMessage : message;
		const progressMessage = total > 0 && !isPaused ? `${resolvedMessage} (${current}/${total})` : resolvedMessage;
		const pauseCategory = this.plugin.ragService.pauseCategoryType;
		const pauseLabel = pauseCategory === 'vision'
			? 'Paused (Vision)'
			: pauseCategory === 'embedding'
				? 'Paused (Embeddings)'
				: pauseCategory === 'connection'
					? 'Paused (Connection)'
					: 'Paused';

		this.ragStatusContent.empty();
		// Secure DOM manipulation used here (createEl instead of innerHTML) to prevent XSS
		const progressContainer = this.ragStatusContent.createEl('div', { cls: 'local-llm-rag-progress' });

		const headerEl = progressContainer.createEl('div', { cls: 'local-llm-rag-progress-header' });
		headerEl.createEl('span', { cls: 'local-llm-rag-progress-icon', text: '⚡' });
		headerEl.createEl('span', { cls: 'local-llm-rag-progress-text', text: 'Indexing Notes' });
		if (isPaused) {
			headerEl.createEl('span', { cls: 'local-llm-rag-paused-pill', text: pauseLabel });
		}

		const detailsEl = progressContainer.createEl('div', { cls: 'local-llm-rag-progress-details' });
		detailsEl.createEl('div', { cls: 'local-llm-rag-progress-message', text: progressMessage });

		const barContainer = detailsEl.createEl('div', { cls: 'local-llm-rag-progress-bar-container' });
		barContainer.createEl('div', {
			cls: 'local-llm-rag-progress-bar',
			attr: { style: `width: ${percentage}%` }
		});

		const footerEl = detailsEl.createEl('div', { cls: 'local-llm-rag-progress-footer' });
		footerEl.createEl('div', { cls: 'local-llm-rag-progress-percentage', text: `${percentage}%` });
		if (isPaused) {
			footerEl.createEl('button', {
				cls: 'mod-cta local-llm-rag-retry-button',
				text: 'Retry Indexing',
				attr: { type: 'button' }
			});
		}
		if (showForceStop) {
			footerEl.createEl('button', {
				cls: 'mod-warning local-llm-rag-cancel-button',
				text: 'Force Stop Indexing',
				attr: { type: 'button' }
			});
		}

		if (isPaused) {
			this.ragStatusArea.addClass('local-llm-rag-status-paused');
		} else {
			this.ragStatusArea.removeClass('local-llm-rag-status-paused');
		}
		this.ragStatusArea.removeClass('local-llm-rag-status-hidden');
		this.ragStatusArea.addClass('local-llm-rag-status-visible');

		const retryButton = this.ragStatusContent.querySelector('.local-llm-rag-retry-button') as HTMLButtonElement | null;
		const cancelButton = this.ragStatusContent.querySelector('.local-llm-rag-cancel-button') as HTMLButtonElement | null;

		if (isPaused) {
			retryButton?.addEventListener('click', () => {
				const resumed = this.plugin.ragService.retryPausedIndexing();
				if (resumed) {
					retryButton.disabled = true;
					if (cancelButton) cancelButton.disabled = true;
					retryButton.textContent = 'Retrying...';
				} else {
					new Notice('Indexing is not currently paused.');
				}
			});
		}

		if (showForceStop) {
			cancelButton?.addEventListener('click', () => {
				this.plugin.ragService.cancelIndexing();
				cancelButton.disabled = true;
				if (retryButton) retryButton.disabled = true;
				cancelButton.textContent = 'Stopping...';
				new Notice('Force stop requested. Indexing will be cancelled.');
			});
		}
	}

	/**
	 * Hide RAG status area
	 */
	private hideRAGStatus(): void {
		this.ragStatusArea.removeClass('local-llm-rag-status-paused');
		this.ragStatusArea.removeClass('local-llm-rag-status-visible');
		this.ragStatusArea.addClass('local-llm-rag-status-hidden');
	}

	/**
	 * Called when RAG indexing completes
	 */
	onRAGIndexingComplete(): void {
		// Update stats display after a brief delay
		setTimeout(() => {
			this.updateRAGStatus();
		}, 1000);
	}

	private showSummaryPreview(summaryMarkdown: string) {
		if (!this.summaryPreviewContainer) return;

		this.summaryPreviewContainer.empty();
		this.summaryPreviewContainer.removeClass('local-llm-summary-preview-hidden');
		this.summaryPreviewContainer.addClass('local-llm-summary-preview-visible');

		const editor = this.summaryPreviewContainer.createEl('textarea', {
			cls: 'local-llm-summary-editor'
		});
		editor.value = summaryMarkdown;

		const controls = this.summaryPreviewContainer.createEl('div', { cls: 'local-llm-summary-controls' });

		const saveBtn = controls.createEl('button', { text: 'Save', attr: { type: 'button' }, cls: 'mod-cta' });
		const saveBothBtn = controls.createEl('button', { text: 'Save summary + conversation', attr: { type: 'button' } });
		const cancelBtn = controls.createEl('button', { text: 'Cancel', attr: { type: 'button' } });
		const resubmitBtn = controls.createEl('button', { text: 'Resummarize', attr: { type: 'button' } });

		saveBtn.addEventListener('click', async () => {
			const content = editor.value;
			const safeName = `Noesis Summary ${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
			try {
				await this.app.vault.create(safeName, content);
				new Notice(`✅ Saved summary: ${safeName}`);
				this.hideSummaryPreview();
				// Open the newly created file
				try {
					await (this.app.workspace as any).openLinkText(safeName, '', true);
				} catch (e) {
					// ignore open errors
				}
			} catch (e) {
				LoggingUtility.error('Failed to save summary note:', e);
				new Notice('❌ Failed to save summary');
			}
		});

		saveBothBtn.addEventListener('click', async () => {
			const content = editor.value;
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			const summaryName = `Noesis Summary ${timestamp}.md`;
			const convoName = `Noesis Conversation ${timestamp}.md`;
			const convoText = this.getConversationText();
			try {
				await this.app.vault.create(summaryName, content);
				await this.app.vault.create(convoName, convoText);
				new Notice(`✅ Saved ${summaryName} and ${convoName}`);
				this.hideSummaryPreview();
				// Open the summary file
				try {
					await (this.app.workspace as any).openLinkText(summaryName, '', true);
				} catch (e) {
					// ignore open errors
				}
			} catch (e) {
				LoggingUtility.error('Failed to save summary and conversation:', e);
				new Notice('❌ Failed to save files');
			}
		});

		cancelBtn.addEventListener('click', () => {
			this.hideSummaryPreview();
		});

		resubmitBtn.addEventListener('click', async () => {
			if (!this.lastConversationForSummary) return;
			resubmitBtn.disabled = true;
			try {
				const prompt = `Please summarize the following conversation again, but make it shorter and more concise (max 150 words).\n\nConversation:\n${this.lastConversationForSummary}`;
				const newSummary = await this.llmService.sendMessage(prompt);
				editor.value = newSummary;
			} catch (err) {
				LoggingUtility.error('Error re-summarizing:', err);
				new Notice('❌ Failed to resummarize');
			} finally {
				resubmitBtn.disabled = false;
			}
		});
	}

	private hideSummaryPreview() {
		if (!this.summaryPreviewContainer) return;
		this.summaryPreviewContainer.empty();
		this.summaryPreviewContainer.removeClass('local-llm-summary-preview-visible');
		this.summaryPreviewContainer.addClass('local-llm-summary-preview-hidden');
	}

} 
