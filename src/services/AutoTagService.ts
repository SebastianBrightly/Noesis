import { App, EventRef, MarkdownView, Menu, Modal, Notice, TAbstractFile, TFile, TFolder } from 'obsidian';
import type LocalLLMPlugin from '../main';
import type { AIConnectionConfig } from '../main';
import { createLLMService, type LLMService } from './LLMService';
import { LoggingUtility } from '../utils/LoggingUtility';

type AutoTagSource = 'context-menu' | 'command';

const MAX_PROMPT_NOTE_CHARS = 12000;
const MAX_TAG_COUNT = 12;
const MAX_ALIAS_COUNT = 8;
const MAX_QUERY_COUNT = 8;
const MAX_DICTIONARY_TAGS_IN_PROMPT = 200;
const TAG_PATTERN = /^[a-z0-9][a-z0-9/_-]*$/;

export interface AutoMetadataSuggestion {
	tags: string[];
	aliases: string[];
	summary?: string;
	retrievalQueries: string[];
}

interface AutoTagApplyResult {
	addedTags: string[];
	addedAliases: string[];
	addedQueries: string[];
	hasSummary: boolean;
}

interface FolderAutoTagConfirmationOptions {
	folderPath: string;
	directNoteCount: number;
	recursiveNoteCount: number;
	workloadLabel: string;
	onDecision: (decision: FolderAutoTagDecision) => void;
}

interface FolderAutoTagDecision {
	proceed: boolean;
	includeSubfolders: boolean;
}

type AutoTagFileStatus = 'applied' | 'skipped' | 'failed';

interface AutoTagFileOutcome {
	status: AutoTagFileStatus;
	result?: AutoTagApplyResult;
	message: string;
}

export function normalizeTag(rawTag: string): string | null {
	const normalized = rawTag
		.trim()
		.toLowerCase()
		.replace(/^#+/, '')
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9/_-]/g, '')
		.replace(/^-+/, '')
		.replace(/-+$/, '');

	if (!normalized) {
		return null;
	}

	if (!TAG_PATTERN.test(normalized)) {
		return null;
	}

	return normalized;
}

function parseTagsValue(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.filter((entry): entry is string => typeof entry === 'string')
			.map((entry) => normalizeTag(entry))
			.filter((entry): entry is string => Boolean(entry));
	}

	if (typeof value === 'string') {
		return value
			.split(/[\n,]/)
			.map((entry) => normalizeTag(entry))
			.filter((entry): entry is string => Boolean(entry));
	}

	return [];
}

function normalizeAlias(rawAlias: string): string | null {
	const normalized = rawAlias
		.trim()
		.replace(/^[-*\s]+/, '')
		.replace(/\s+/g, ' ');

	if (!normalized) {
		return null;
	}

	return normalized.slice(0, 80);
}

function parseAliasesValue(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.filter((entry): entry is string => typeof entry === 'string')
			.map((entry) => normalizeAlias(entry))
			.filter((entry): entry is string => Boolean(entry));
	}

	if (typeof value === 'string') {
		return value
			.split(/[\n,]/)
			.map((entry) => normalizeAlias(entry))
			.filter((entry): entry is string => Boolean(entry));
	}

	return [];
}

function normalizeQuery(rawQuery: string): string | null {
	const normalized = rawQuery
		.trim()
		.replace(/^[-*\s]+/, '')
		.replace(/\s+/g, ' ');

	if (!normalized) {
		return null;
	}

	return normalized.slice(0, 120);
}

function parseQueriesValue(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.filter((entry): entry is string => typeof entry === 'string')
			.map((entry) => normalizeQuery(entry))
			.filter((entry): entry is string => Boolean(entry));
	}

	if (typeof value === 'string') {
		return value
			.split(/[\n,]/)
			.map((entry) => normalizeQuery(entry))
			.filter((entry): entry is string => Boolean(entry));
	}

	return [];
}

function parseSummaryValue(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const normalized = value.trim().replace(/\s+/g, ' ');
	if (!normalized) {
		return undefined;
	}

	return normalized.slice(0, 280);
}

function parseJsonCandidate(response: string): unknown {
	const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) {
		return JSON.parse(fenced[1]);
	}

	const objectMatch = response.match(/\{[\s\S]*\}/);
	if (objectMatch) {
		return JSON.parse(objectMatch[0]);
	}

	if (response.trim().startsWith('[')) {
		return JSON.parse(response.trim());
	}

	return null;
}

export function parseAutoTagResponse(response: string): string[] {
	return parseAutoMetadataResponse(response).tags;
}

export function parseAutoMetadataResponse(response: string): AutoMetadataSuggestion {
	const trimmed = response.trim();
	if (!trimmed) {
		return {
			tags: [],
			aliases: [],
			retrievalQueries: []
		};
	}

	try {
		const parsed = parseJsonCandidate(trimmed);
		if (Array.isArray(parsed)) {
			return {
				tags: Array.from(new Set(parseTagsValue(parsed))).slice(0, MAX_TAG_COUNT),
				aliases: [],
				retrievalQueries: []
			};
		}

		if (parsed && typeof parsed === 'object') {
			const typed = parsed as {
				tags?: unknown;
				aliases?: unknown;
				summary?: unknown;
				retrieval_queries?: unknown;
				retrievalQueries?: unknown;
			};

			return {
				tags: Array.from(new Set(parseTagsValue(typed.tags))).slice(0, MAX_TAG_COUNT),
				aliases: Array.from(new Set(parseAliasesValue(typed.aliases))).slice(0, MAX_ALIAS_COUNT),
				summary: parseSummaryValue(typed.summary),
				retrievalQueries: Array.from(
					new Set(parseQueriesValue(typed.retrieval_queries ?? typed.retrievalQueries))
				).slice(0, MAX_QUERY_COUNT)
			};
		}
	} catch (_error) {
		// Fall through to plain-text parsing.
	}

	const plainTags = trimmed
		.split(/[\n,]/)
		.map((line) => line.replace(/^[-*\s]+/, ''))
		.map((line) => normalizeTag(line))
		.filter((entry): entry is string => Boolean(entry));

	return {
		tags: Array.from(new Set(plainTags)).slice(0, MAX_TAG_COUNT),
		aliases: [],
		retrievalQueries: []
	};
}

export class AutoTagService {
	private readonly inFlightFiles = new Set<string>();
	private readonly inFlightFolders = new Set<string>();

	constructor(private readonly plugin: LocalLLMPlugin) {}

	register(): void {
		const workspaceEvents = this.plugin.app.workspace as unknown as {
			on: (eventName: string, callback: (...args: unknown[]) => void) => EventRef;
		};

		this.plugin.addCommand({
			id: 'auto-tag-active-folder',
			name: 'Auto tag active folder',
			checkCallback: (checking: boolean) => {
				const folder = this.getActiveFolder();
				if (!folder) {
					return false;
				}

				if (!checking) {
					void this.autoTagFolder(folder, 'command');
				}

				return true;
			}
		});

		this.plugin.addCommand({
			id: 'auto-tag-active-note',
			name: 'Auto tag active note',
			checkCallback: (checking: boolean) => {
				const file = this.getActiveMarkdownFile();
				if (!file) {
					return false;
				}

				if (!checking) {
					void this.autoTagFile(file, 'command');
				}

				return true;
			}
		});

		this.plugin.registerEvent(
			workspaceEvents.on('file-menu', (menu: Menu, file: TAbstractFile) => {
				if (file instanceof TFolder) {
					menu.addSeparator();
					menu.addItem((item) => {
						item
							.setTitle('Noesis: Auto tag folder')
							.setIcon('folder-search')
							.onClick(() => {
								void this.autoTagFolder(file, 'context-menu');
							});
					});
					return;
				}

				if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') {
					return;
				}

				menu.addSeparator();
				menu.addItem((item) => {
					item
						.setTitle('Noesis: Auto tag')
						.setIcon('tags')
						.onClick(() => {
							void this.autoTagFile(file, 'context-menu');
						});
				});
			})
		);

		this.plugin.registerEvent(
			workspaceEvents.on('editor-menu', (menu: Menu, _editor: unknown, view: MarkdownView) => {
				const file = view?.file;
				if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') {
					return;
				}

				menu.addSeparator();
				menu.addItem((item) => {
					item
						.setTitle('Noesis: Auto tag this note')
						.setIcon('tags')
						.onClick(() => {
							void this.autoTagFile(file, 'context-menu');
						});
				});
			})
		);

		LoggingUtility.log('Auto tag service registered');
	}

	private getActiveMarkdownFile(): TFile | null {
		const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView?.file || activeView.file.extension.toLowerCase() !== 'md') {
			return null;
		}

		return activeView.file;
	}

	private getActiveFolder(): TFolder | null {
		const activeFile = this.getActiveMarkdownFile();
		if (activeFile?.parent instanceof TFolder) {
			return activeFile.parent;
		}

		return null;
	}

	private getMarkdownFilesInFolder(folder: TFolder, includeSubfolders: boolean): TFile[] {
		const basePath = folder.path.trim();
		if (basePath.length === 0) {
			return this.plugin.app.vault.getMarkdownFiles();
		}

		const prefix = `${basePath}/`;
		return this.plugin.app.vault
			.getMarkdownFiles()
			.filter((file) => {
				if (!file.path.startsWith(prefix)) {
					return false;
				}

				if (includeSubfolders) {
					return true;
				}

				const remainder = file.path.slice(prefix.length);
				return !remainder.includes('/');
			});
	}

	private getConfiguredDictionaryTags(): string[] {
		const configured = this.plugin.settings.autoTagDictionary || [];
		return Array.from(
			new Set(
				configured
					.map((entry) => normalizeTag(entry))
					.filter((entry): entry is string => Boolean(entry))
			)
		);
	}

	private estimateRelevantDictionaryTags(noteBody: string, dictionaryTags: string[]): string[] {
		if (dictionaryTags.length === 0) {
			return [];
		}

		const normalizedBody = noteBody.toLowerCase();
		const scored = dictionaryTags
			.map((tag) => {
				const segments = tag.split(/[\/-]/).filter((segment) => segment.length > 2);
				let score = 0;
				for (const segment of segments) {
					if (normalizedBody.includes(segment)) {
						score += 1;
					}
				}
				return { tag, score };
			})
			.filter((item) => item.score > 0)
			.sort((a, b) => b.score - a.score);

		return scored.slice(0, 3).map((item) => item.tag);
	}

	private getWorkloadProfile(): { size: number; delayMs: number; label: string } {
		switch (this.plugin.settings.autoTagWorkload) {
			case 'small':
				return { size: 3, delayMs: 150, label: 'small' };
			case 'large':
				return { size: 20, delayMs: 0, label: 'large' };
			case 'medium':
			default:
				return { size: 8, delayMs: 50, label: 'medium' };
		}
	}

	private confirmFolderAutoTag(folderPath: string, directNoteCount: number, recursiveNoteCount: number, workloadLabel: string): Promise<FolderAutoTagDecision> {
		return new Promise((resolve) => {
			new FolderAutoTagConfirmationModal(this.plugin.app, {
				folderPath,
				directNoteCount,
				recursiveNoteCount,
				workloadLabel,
				onDecision: resolve
			}).open();
		});
	}

	private extractNoteBody(content: string): string {
		const frontmatterMatch = content.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
		if (!frontmatterMatch) {
			return content;
		}

		return content.slice(frontmatterMatch[0].length);
	}

	private getExistingTags(file: TFile): string[] {
		const fileCache = this.plugin.app.metadataCache.getFileCache(file);
		const frontmatter = fileCache?.frontmatter as { tags?: unknown } | undefined;
		return Array.from(new Set(parseTagsValue(frontmatter?.tags)));
	}

	private getExistingAliases(file: TFile): string[] {
		const fileCache = this.plugin.app.metadataCache.getFileCache(file);
		const frontmatter = fileCache?.frontmatter as { aliases?: unknown } | undefined;
		return Array.from(new Set(parseAliasesValue(frontmatter?.aliases)));
	}

	private getExistingRetrievalQueries(file: TFile): string[] {
		const fileCache = this.plugin.app.metadataCache.getFileCache(file);
		const frontmatter = fileCache?.frontmatter as { noesisRagQueries?: unknown } | undefined;
		return Array.from(new Set(parseQueriesValue(frontmatter?.noesisRagQueries)));
	}

	private buildPrompt(notePath: string, existingTags: string[], dictionaryTags: string[], noteBody: string): string {
		const existing = existingTags.length > 0 ? existingTags.join(', ') : 'none';
		const dictionary = dictionaryTags.length > 0 ? dictionaryTags.slice(0, MAX_DICTIONARY_TAGS_IN_PROMPT).join(', ') : 'none';
		const truncatedBody = noteBody.slice(0, MAX_PROMPT_NOTE_CHARS);

		return [
			'You are generating retrieval-oriented metadata tags for an Obsidian note used in a RAG system.',
			'Generate metadata that improves semantic retrieval and topic clustering.',
			'Rules:',
			'- lowercase only',
			'- kebab-case or slash-hierarchy style (example: machine-learning, project/research)',
			'- no hashtags',
			'- avoid duplicates or near-duplicates of existing tags',
			'- avoid vague tags like note, idea, misc',
			'- if one or more tags from the provided dictionary are relevant, include at least one of them',
			'- summary should be one sentence about what this note is about',
			'- retrieval queries should be short natural-language search phrases',
			'',
			'Return strict JSON only in this shape:',
			'{"tags": ["tag-one", "tag-two"], "aliases": ["alias one"], "summary": "short summary", "retrieval_queries": ["search phrase"]}',
			'',
			`Note path: ${notePath}`,
			`Existing tags: ${existing}`,
			`Dictionary tags: ${dictionary}`,
			'Note content:',
			'"""',
			truncatedBody,
			'"""'
		].join('\n');
	}

	private getAutoTagConnectionConfig(): AIConnectionConfig | undefined {
		const selectedId = this.plugin.settings.autoTagConnectionId;
		if (!selectedId) {
			return undefined;
		}

		const connections = (this.plugin.settings.multiAIConnections || []) as AIConnectionConfig[];
		return connections.find((connection) => connection.id === selectedId && !connection.isSleeping);
	}

	private buildAutoTagLLMService(): LLMService {
		const connection = this.getAutoTagConnectionConfig();
		if (!connection) {
			return this.plugin.llmService as LLMService;
		}

		return createLLMService({
			apiEndpoint: connection.apiEndpoint,
			apiKey: connection.apiKey,
			maxTokens: connection.maxTokens,
			temperature: connection.temperature,
			systemPrompt: this.plugin.settings.systemPrompt,
			model: connection.model,
			enableShortResponses: this.plugin.settings.enableShortResponses,
			augmentSystemPromptwithPersonality: this.plugin.settings.augmentSystemPromptwithPersonality,
			personalityPrompt: Array.isArray(this.plugin.settings.personalityPrompt) ? this.plugin.settings.personalityPrompt[0] : this.plugin.settings.personalityPrompt,
			personalityName: this.plugin.settings.personalityName
		});
	}

	private async applyMetadata(file: TFile, metadata: AutoMetadataSuggestion): Promise<AutoTagApplyResult> {
		const existingTags = this.getExistingTags(file);
		const existingAliases = this.getExistingAliases(file);
		const existingQueries = this.getExistingRetrievalQueries(file);

		const mergedTags = Array.from(new Set([...existingTags, ...metadata.tags]));
		const mergedAliases = Array.from(new Set([...existingAliases, ...metadata.aliases]));
		const mergedQueries = Array.from(new Set([...existingQueries, ...metadata.retrievalQueries]));
		const summary = metadata.summary;

		await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			frontmatter.tags = mergedTags;
			if (mergedAliases.length > 0) {
				frontmatter.aliases = mergedAliases;
			}
			if (summary) {
				frontmatter.noesisRagSummary = summary;
			}
			if (mergedQueries.length > 0) {
				frontmatter.noesisRagQueries = mergedQueries;
			}
			frontmatter.noesisAutoTaggedAt = new Date().toISOString();
		});

		return {
			addedTags: mergedTags.filter((tag) => !existingTags.includes(tag)),
			addedAliases: mergedAliases.filter((alias) => !existingAliases.includes(alias)),
			addedQueries: mergedQueries.filter((query) => !existingQueries.includes(query)),
			hasSummary: Boolean(summary)
		};
	}

	private async autoTagFolder(folder: TFolder, source: AutoTagSource): Promise<void> {
		const folderKey = folder.path || '/';
		if (this.inFlightFolders.has(folderKey)) {
			new Notice('Noesis is already auto-tagging this folder.');
			return;
		}

		const directFiles = this.getMarkdownFilesInFolder(folder, false);
		const recursiveFiles = this.getMarkdownFilesInFolder(folder, true);
		const workloadProfile = this.getWorkloadProfile();
		if (recursiveFiles.length === 0) {
			new Notice('No markdown notes found in this folder.');
			return;
		}

		const decision = await this.confirmFolderAutoTag(folderKey, directFiles.length, recursiveFiles.length, workloadProfile.label);
		if (!decision.proceed) {
			return;
		}

		const files = decision.includeSubfolders ? recursiveFiles : directFiles;
		if (files.length === 0) {
			new Notice('No markdown notes found for the selected scope.');
			return;
		}

		this.inFlightFolders.add(folderKey);
		let workingNotice = new Notice(`Noesis auto-tag folder: Working... (0/${files.length})`, 0);
		const progressModal = new FolderAutoTagProgressModal(this.plugin.app, {
			folderPath: folderKey,
			totalFiles: files.length,
			includeSubfolders: decision.includeSubfolders,
			workloadLabel: workloadProfile.label,
			chunkSize: workloadProfile.size
		});
		progressModal.open();
		let processed = 0;
		let skipped = 0;
		let failed = 0;
		let totalTags = 0;
		let totalAliases = 0;
		let totalQueries = 0;

		try {
			for (let chunkStart = 0; chunkStart < files.length; chunkStart += workloadProfile.size) {
				const chunk = files.slice(chunkStart, chunkStart + workloadProfile.size);
				const chunkIndex = Math.floor(chunkStart / workloadProfile.size) + 1;
				const totalChunks = Math.ceil(files.length / workloadProfile.size);
				progressModal.appendLog(`[CHUNK] Starting chunk ${chunkIndex}/${totalChunks} (${chunk.length} note(s))`);

				for (let offset = 0; offset < chunk.length; offset++) {
					const file = chunk[offset];
					const globalIndex = chunkStart + offset;
					progressModal.updateStatus(`Processing ${globalIndex + 1}/${files.length}: ${file.path}`);
					const outcome = await this.autoTagFile(file, source, {
						showWorkingNotice: false,
						showResultNotice: false
					});

					if (outcome.status === 'applied' && outcome.result) {
						processed += 1;
						totalTags += outcome.result.addedTags.length;
						totalAliases += outcome.result.addedAliases.length;
						totalQueries += outcome.result.addedQueries.length;
						progressModal.appendLog(
							`[APPLIED] ${file.path} (+${outcome.result.addedTags.length} tags, +${outcome.result.addedAliases.length} aliases, +${outcome.result.addedQueries.length} queries)`
						);
					} else if (outcome.status === 'failed') {
						failed += 1;
						progressModal.appendLog(`[FAILED] ${file.path} (${outcome.message})`);
					} else {
						skipped += 1;
						progressModal.appendLog(`[SKIPPED] ${file.path} (${outcome.message})`);
					}

					workingNotice.hide();
					workingNotice = new Notice(`Noesis auto-tag folder: Working... (${globalIndex + 1}/${files.length})`, 0);
				}

				if (workloadProfile.delayMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, workloadProfile.delayMs));
				}
			}
		} catch (error: unknown) {
			failed += Math.max(1, files.length - processed - skipped - failed);
			LoggingUtility.error('Folder auto-tagging failed', {
				folder: folderKey,
				source,
				error
			});
			progressModal.appendLog(`[FAILED] Batch aborted: ${error instanceof Error ? error.message : String(error)}`);
			new Notice('Noesis folder auto-tag failed. Check endpoint and logs.');
		} finally {
			workingNotice.hide();
			this.inFlightFolders.delete(folderKey);
		}

		progressModal.finish({
			processed,
			skipped,
			failed,
			totalTags,
			totalAliases,
			totalQueries
		});

		new Notice(
			`Noesis folder auto-tag complete: ${processed} processed, ${skipped} skipped, ${failed} failed, +${totalTags} tags, +${totalAliases} aliases, +${totalQueries} queries.`
		);
	}

	private async autoTagFile(
		file: TFile,
		source: AutoTagSource,
		options?: {
			showWorkingNotice?: boolean;
			showResultNotice?: boolean;
		}
	): Promise<AutoTagFileOutcome> {
		const showWorkingNotice = options?.showWorkingNotice ?? true;
		const showResultNotice = options?.showResultNotice ?? true;

		const autoTagLLMService = this.buildAutoTagLLMService();
		if (!autoTagLLMService) {
			if (showResultNotice) {
				new Notice('Noesis is still initializing. Try again in a moment.');
			}
			return {
				status: 'failed',
				message: 'LLM service unavailable'
			};
		}

		if (this.inFlightFiles.has(file.path)) {
			if (showResultNotice) {
				new Notice('Noesis is already auto-tagging this note.');
			}
			return {
				status: 'skipped',
				message: 'already in progress'
			};
		}

		this.inFlightFiles.add(file.path);
		const workingNotice = showWorkingNotice ? new Notice('Noesis auto-tag: Working...', 0) : null;

		try {
			const noteContent = await this.plugin.app.vault.read(file);
			const noteBody = this.extractNoteBody(noteContent).trim();

			if (!noteBody) {
				workingNotice?.hide();
				if (showResultNotice) {
					new Notice('Note is empty. Add content before auto-tagging.');
				}
				return {
					status: 'skipped',
					message: 'note is empty'
				};
			}

			const existingTags = this.getExistingTags(file);
			const dictionaryTags = this.getConfiguredDictionaryTags();
			const prompt = this.buildPrompt(file.path, existingTags, dictionaryTags, noteBody);
			const response = await autoTagLLMService.sendMessage(prompt);
			const generatedMetadata = parseAutoMetadataResponse(response);
			const relevantDictionaryTags = this.estimateRelevantDictionaryTags(noteBody, dictionaryTags);
			if (relevantDictionaryTags.length > 0) {
				generatedMetadata.tags = Array.from(new Set([...relevantDictionaryTags, ...generatedMetadata.tags])).slice(0, MAX_TAG_COUNT);
			}

			if (generatedMetadata.tags.length === 0) {
				workingNotice?.hide();
				LoggingUtility.warn('Auto-tagging produced no usable tags', { filePath: file.path, source, response });
				if (showResultNotice) {
					new Notice('Noesis could not generate valid tags for this note.');
				}
				return {
					status: 'skipped',
					message: 'no valid tags generated'
				};
			}

			const applied = await this.applyMetadata(file, generatedMetadata);
			workingNotice?.hide();
			if (applied.addedTags.length === 0 && applied.addedAliases.length === 0 && applied.addedQueries.length === 0 && !applied.hasSummary) {
				if (showResultNotice) {
					new Notice('Noesis found only existing metadata. No changes were needed.');
				}
				return {
					status: 'skipped',
					message: 'no metadata changes needed'
				};
			}

			LoggingUtility.log('Auto-tagging completed', {
				filePath: file.path,
				source,
				addedTagCount: applied.addedTags.length,
				addedAliasCount: applied.addedAliases.length,
				addedQueryCount: applied.addedQueries.length,
				hasSummary: applied.hasSummary,
				addedTags: applied.addedTags,
				addedAliases: applied.addedAliases,
				addedQueries: applied.addedQueries
			});

			if (showResultNotice) {
				new Notice(`Noesis updated RAG metadata (${applied.addedTags.length} tags, ${applied.addedAliases.length} aliases, ${applied.addedQueries.length} queries).`);
			}

			return {
				status: 'applied',
				message: 'metadata updated',
				result: applied
			};
		} catch (error: unknown) {
			workingNotice?.hide();
			LoggingUtility.error('Auto-tagging failed', {
				filePath: file.path,
				source,
				error
			});
			if (showResultNotice) {
				new Notice('Noesis auto-tag failed. Check endpoint and logs.');
			}
			return {
				status: 'failed',
				message: error instanceof Error ? error.message : String(error)
			};
		} finally {
			this.inFlightFiles.delete(file.path);
		}
	}
}

class FolderAutoTagConfirmationModal extends Modal {
	private readonly options: FolderAutoTagConfirmationOptions;
	private hasDecided = false;

	constructor(app: App, options: FolderAutoTagConfirmationOptions) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('local-llm-editor-result-modal');

		contentEl.createEl('h2', { text: 'Noesis: Auto tag folder' });
		contentEl.createEl('p', {
			text: `This will auto-tag notes in "${this.options.folderPath}".`
		});
		contentEl.createEl('p', {
			text: 'Depending on folder size, this may take a while. Do you want to proceed?'
		});
		contentEl.createEl('p', {
			text: `Current workload profile: ${this.options.workloadLabel}`
		});

		const scopeWrapper = contentEl.createDiv();
		scopeWrapper.createEl('p', { text: 'Choose scope:' });

		const directScopeLabel = scopeWrapper.createEl('label', { cls: 'local-llm-folder-scope-label' });
		const directScopeInput = directScopeLabel.createEl('input', {
			attr: { type: 'radio', name: 'noesis-folder-scope' }
		});
		directScopeInput.checked = true;
		directScopeLabel.appendText(` This folder only (${this.options.directNoteCount} note(s))`);

		const recursiveScopeLabel = scopeWrapper.createEl('label', { cls: 'local-llm-folder-scope-label' });
		const recursiveScopeInput = recursiveScopeLabel.createEl('input', {
			attr: { type: 'radio', name: 'noesis-folder-scope' }
		});
		recursiveScopeLabel.appendText(` Include subfolders (${this.options.recursiveNoteCount} note(s))`);

		const actions = contentEl.createDiv({ cls: 'local-llm-editor-result-actions' });

		const cancelButton = actions.createEl('button', {
			text: 'Do not proceed',
			attr: { type: 'button' }
		});

		const proceedButton = actions.createEl('button', {
			text: 'Proceed',
			cls: 'mod-cta',
			attr: { type: 'button' }
		});

		cancelButton.addEventListener('click', () => {
			this.hasDecided = true;
			this.options.onDecision({ proceed: false, includeSubfolders: false });
			this.close();
		});

		proceedButton.addEventListener('click', () => {
			this.hasDecided = true;
			this.options.onDecision({ proceed: true, includeSubfolders: recursiveScopeInput.checked });
			this.close();
		});
	}

	onClose(): void {
		if (!this.hasDecided) {
			this.options.onDecision({ proceed: false, includeSubfolders: false });
		}
		this.contentEl.empty();
	}
}

class FolderAutoTagProgressModal extends Modal {
	private readonly folderPath: string;
	private readonly totalFiles: number;
	private readonly includeSubfolders: boolean;
	private readonly workloadLabel: string;
	private readonly chunkSize: number;
	private statusEl: HTMLElement | null = null;
	private logEl: HTMLElement | null = null;

	constructor(app: App, options: { folderPath: string; totalFiles: number; includeSubfolders: boolean; workloadLabel: string; chunkSize: number }) {
		super(app);
		this.folderPath = options.folderPath;
		this.totalFiles = options.totalFiles;
		this.includeSubfolders = options.includeSubfolders;
		this.workloadLabel = options.workloadLabel;
		this.chunkSize = options.chunkSize;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('local-llm-editor-result-modal');

		contentEl.createEl('h2', { text: 'Noesis: Folder Auto-tag Progress' });
		contentEl.createEl('p', {
			text: `Folder: ${this.folderPath}`
		});
		contentEl.createEl('p', {
			text: `Scope: ${this.includeSubfolders ? 'Including subfolders' : 'This folder only'} (${this.totalFiles} note(s))`
		});
		contentEl.createEl('p', {
			text: `Workload: ${this.workloadLabel} (chunk size ${this.chunkSize})`
		});

		this.statusEl = contentEl.createEl('p', {
			text: 'Preparing...'
		});

		this.logEl = contentEl.createEl('pre', { cls: 'noesis-first-run-structure-preview' });
		this.logEl.textContent = '';
	}

	updateStatus(status: string): void {
		if (this.statusEl) {
			this.statusEl.setText(status);
		}
	}

	appendLog(entry: string): void {
		if (!this.logEl) {
			return;
		}

		const existing = this.logEl.textContent ?? '';
		this.logEl.textContent = `${existing}${existing ? '\n' : ''}${entry}`;
		this.logEl.scrollTop = this.logEl.scrollHeight;
	}

	finish(summary: {
		processed: number;
		skipped: number;
		failed: number;
		totalTags: number;
		totalAliases: number;
		totalQueries: number;
	}): void {
		this.updateStatus('Completed');
		this.appendLog(
			`Done: ${summary.processed} processed, ${summary.skipped} skipped, ${summary.failed} failed, +${summary.totalTags} tags, +${summary.totalAliases} aliases, +${summary.totalQueries} queries.`
		);
	}

	onClose(): void {
		this.contentEl.empty();
		this.statusEl = null;
		this.logEl = null;
	}
}
