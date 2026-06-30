import { App, TFile, CachedMetadata, MarkdownView } from 'obsidian';
import { LoggingUtility } from '../utils/LoggingUtility';
import { RAGService } from './RAGService';

interface GraphRerankSettings {
	graphWeightSemantic?: number;
	graphWeightBacklinkDistance?: number;
	graphWeightRecency?: number;
	graphWeightBookmarked?: number;
	graphWeightFolderProximity?: number;
	graphRecencyHalfLifeDays?: number;
	enableDeveloperLogging?: boolean;
}

interface SearchResultGraphDebug {
	semantic: number;
	backlinkDistanceScore: number;
	recencyScore: number;
	bookmarkedScore: number;
	folderScore: number;
	backlinkDistanceRaw: number | null;
	daysSinceModified: number;
	weights: {
		semantic: number;
		backlinkDistance: number;
		recency: number;
		bookmarked: number;
		folder: number;
	};
	rawWeightedScore: number;
	normalizedScore: number;
}

export interface SearchResult {
	file: TFile;
	content: string;
	relevance: number;
	title: string;
	path: string;
	paragraphIndex?: number;
	sectionIndex?: number;
	anchorType?: 'block' | 'heading' | 'chunk';
	anchorValue?: string;
	anchorTarget?: string;
	headingPath?: string;
	headingSlug?: string;
	graphDebug?: SearchResultGraphDebug;
}

export interface SearchOptions {
	maxResults?: number;
	maxTokens?: number;
	threshold?: number;
}

interface CandidateFile {
	file: TFile;
	metadata: CachedMetadata | null;
	baseScore: number;
}

interface BookmarkItem {
	type?: string;
	path?: string;
	items?: BookmarkItem[];
}

interface AppWithInternalPlugins {
	internalPlugins?: {
		plugins?: {
			bookmarks?: {
				instance?: {
					items?: BookmarkItem[];
				};
			};
		};
	};
}

export class SearchService {
	private app: App;
	private ragService: RAGService | null = null;
	private readonly defaultGraphWeightSemantic = 0.2;
	private readonly defaultGraphWeightBacklinkDistance = 0.45;
	private readonly defaultGraphWeightRecency = 0.25;
	private readonly defaultGraphWeightBookmarked = 0.2;
	private readonly defaultGraphWeightFolderProximity = 0.1;
	private readonly defaultRecencyHalfLifeDays = 21;
	private readonly getGraphSettings?: () => GraphRerankSettings;

	constructor(app: App, ragService?: RAGService, getGraphSettings?: () => GraphRerankSettings) {
		this.app = app;
		this.ragService = ragService || null;
		this.getGraphSettings = getGraphSettings;
	}

	private resolveGraphRerankSettings(): Required<Pick<GraphRerankSettings,
		'graphWeightSemantic' |
		'graphWeightBacklinkDistance' |
		'graphWeightRecency' |
		'graphWeightBookmarked' |
		'graphWeightFolderProximity' |
		'graphRecencyHalfLifeDays' |
		'enableDeveloperLogging'>> {
		const settings = this.getGraphSettings ? this.getGraphSettings() : {};
		return {
			graphWeightSemantic: Number(settings.graphWeightSemantic ?? this.defaultGraphWeightSemantic),
			graphWeightBacklinkDistance: Number(settings.graphWeightBacklinkDistance ?? this.defaultGraphWeightBacklinkDistance),
			graphWeightRecency: Number(settings.graphWeightRecency ?? this.defaultGraphWeightRecency),
			graphWeightBookmarked: Number(settings.graphWeightBookmarked ?? this.defaultGraphWeightBookmarked),
			graphWeightFolderProximity: Number(settings.graphWeightFolderProximity ?? this.defaultGraphWeightFolderProximity),
			graphRecencyHalfLifeDays: Math.max(1, Number(settings.graphRecencyHalfLifeDays ?? this.defaultRecencyHalfLifeDays)),
			enableDeveloperLogging: Boolean(settings.enableDeveloperLogging)
		};
	}

	/**
	 * Set the RAG service instance
	 */
	setRAGService(ragService: RAGService): void {
		this.ragService = ragService;
	}

	/**
	 * Resolve the best available markdown file for context scoping.
	 * Fallback order: active markdown view -> active leaf markdown file -> any open markdown leaf.
	 */
	private resolvePreferredMarkdownFile(): TFile | null {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const activeViewFile = activeView?.file;
		if (activeViewFile && activeViewFile.extension === 'md') {
			return activeViewFile;
		}

		const activeLeaf = (this.app.workspace as unknown as { activeLeaf?: { view?: unknown } }).activeLeaf;
		const activeLeafView = activeLeaf?.view as { getViewType?: () => string; file?: TFile } | undefined;
		if (activeLeafView?.getViewType?.() === 'markdown') {
			const activeLeafFile = activeLeafView.file;
			if (activeLeafFile && activeLeafFile.extension === 'md') {
				return activeLeafFile;
			}
		}

		const markdownLeaves = this.app.workspace.getLeavesOfType('markdown');
		for (const leaf of markdownLeaves) {
			if (leaf.view instanceof MarkdownView) {
				const file = leaf.view.file;
				if (file && file.extension === 'md') {
					return file;
				}
			}
		}

		return null;
	}

	/**
	 * Get the folder path currently used by Current Folder scope.
	 */
	getCurrentFolderScopePath(): string | null {
		const file = this.resolvePreferredMarkdownFile();
		if (!file || file.extension !== 'md') {
			return null;
		}

		return file.parent?.path || '/';
	}

	/**
	 * Search for relevant notes using RAG (fallback to keyword search if RAG unavailable)
	 */
	async searchVault(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
		return this.searchVaultInFiles(query, undefined, options);
	}

	/**
	 * Search for relevant notes constrained to a specific file scope.
	 */
	async searchVaultInFiles(query: string, files: TFile[] | undefined, options: SearchOptions = {}): Promise<SearchResult[]> {
		LoggingUtility.log('Searching vault for:', query);
		LoggingUtility.log('Search options:', options);
		if (files) {
			LoggingUtility.log(`Search constrained to ${files.length} scoped files`);
		}

		const fileScope = files && files.length > 0 ? files : undefined;
		const scopedPathSet = fileScope ? new Set(fileScope.map(file => file.path)) : undefined;

		// Try RAG search first
		if (this.ragService && !this.ragService.isIndexEmpty()) {
			try {
				LoggingUtility.log('Using RAG search');
				const maxResults = options.maxResults || 5;
				const ragPoolLimit = Math.max(maxResults * 4, 12);
				const ragResults = await this.ragService.search(
					query,
					ragPoolLimit,
					options.threshold || 0.3
				);

				// Convert RAG results to SearchResult format
				const searchResults = ragResults.map(result => ({
					file: result.file,
					content: result.content,
					relevance: result.similarity,
					title: result.title,
					path: result.path,
					paragraphIndex: result.paragraphIndex,
					sectionIndex: result.sectionIndex,
					anchorType: result.anchorType,
					anchorValue: result.anchorValue,
					anchorTarget: result.anchorTarget,
					headingPath: result.headingPath,
					headingSlug: result.headingSlug
				})).filter(result => !scopedPathSet || scopedPathSet.has(result.path));

				const rerankedResults = await this.rerankResultsWithGraphSignals(searchResults);

				const perResultTokenBudget = Math.max(80, Math.floor((options.maxTokens || 1000) / Math.max(maxResults, 1)));
				const expandedResults = await this.expandResultsWithNeighborContext(rerankedResults, perResultTokenBudget);
				const packedResults = this.packResultsToTokenBudget(
					expandedResults,
					options.maxTokens || 1000,
					maxResults
				);

				LoggingUtility.log(`RAG search completed. Found ${packedResults.length} packed relevant notes from ${rerankedResults.length} candidates.`);
				return packedResults;
			} catch (error) {
				LoggingUtility.warn('RAG search failed, falling back to keyword search:', error);
			}
		}

		// Fallback to keyword search if RAG is unavailable
		LoggingUtility.log('Using keyword search fallback');
		return await this.keywordSearchVault(query, options, fileScope);
	}

	/**
	 * Keyword search fallback (original implementation)
	 */
	private async keywordSearchVault(query: string, options: SearchOptions = {}, scopedFiles?: TFile[]): Promise<SearchResult[]> {
		const files = scopedFiles && scopedFiles.length > 0 ? scopedFiles : this.app.vault.getMarkdownFiles();
		LoggingUtility.log(`Found ${files.length} markdown files to search`);
		const threshold = options.threshold || 0.1;
		const queryTerms = this.extractQueryTerms(query);

		if (queryTerms.length === 0) {
			return [];
		}

		const candidates: CandidateFile[] = [];
		for (const file of files) {
			const metadata = this.app.metadataCache.getFileCache(file);
			const baseScore = this.calculateMetadataRelevance(queryTerms, metadata, file);
			if (baseScore > 0) {
				candidates.push({ file, metadata, baseScore });
			}
		}

		candidates.sort((a, b) => b.baseScore - a.baseScore);
		const candidateLimit = Math.min(files.length, Math.max((options.maxResults || 5) * 8, 25));
		const topCandidates = candidates.slice(0, candidateLimit);

		LoggingUtility.log(`Keyword prescoring selected ${topCandidates.length} candidate files from ${files.length} total files`);

		const results: SearchResult[] = [];

		for (const candidate of topCandidates) {
			try {
				const result = await this.searchFile(candidate, query, queryTerms, options);
				if (result && result.relevance >= threshold) {
					results.push(result);
					LoggingUtility.log(`Found relevant file: ${result.title} (${(result.relevance * 100).toFixed(1)}% relevant)`);
				}
			} catch (error) {
				LoggingUtility.error(`Error searching file ${candidate.file.path}:`, error);
			}
		}

		// Sort by relevance and limit results
		const sortedResults = results.sort((a, b) => b.relevance - a.relevance);
		const finalResults = sortedResults.slice(0, options.maxResults || 5);

		LoggingUtility.log(`Keyword search completed. Found ${finalResults.length} relevant notes out of ${results.length} total matches.`);
		return finalResults;
	}

	/**
	 * Search a single file for relevance to the query
	 */
	private async searchFile(candidate: CandidateFile, query: string, queryTerms: string[], options: SearchOptions): Promise<SearchResult | null> {
		try {
			const { file, metadata, baseScore } = candidate;
			// Read file content
			const content = await this.app.vault.cachedRead(file);
			
			// Calculate relevance score
			const relevance = this.calculateRelevance(queryTerms, content, metadata, baseScore);
			
			if (relevance < (options.threshold || 0.1)) {
				return null;
			}

			// Extract relevant content
			const relevantContent = this.extractRelevantContent(content, query, options.maxTokens || 1000);
			
			return {
				file,
				content: relevantContent,
				relevance,
				title: this.getFileTitle(file, metadata),
				path: file.path
			};

		} catch (error) {
			LoggingUtility.error(`Error processing file ${candidate.file.path}:`, error);
			return null;
		}
	}

	/**
	 * Calculate relevance score for a file based on the query
	 */
	private calculateRelevance(queryTerms: string[], content: string, metadata: CachedMetadata | null, baseScore: number = 0): number {
		if (queryTerms.length === 0) {
			return 0;
		}

		const contentLower = content.toLowerCase();
		
		let score = baseScore;
		let totalTerms = queryTerms.length;

		for (const term of queryTerms) {
			let termScore = 0;
			
			// Check content
			const contentMatches = (contentLower.match(new RegExp(term, 'gi')) || []).length;
			termScore += Math.min(contentMatches * 0.8, 8); // Cap at 8 points for content matches
			
			score += termScore;
		}

		// Normalize score to 0-1 range
		return Math.min(score / (totalTerms * 18), 1);
	}

	private extractQueryTerms(query: string): string[] {
		return query.toLowerCase().split(/\s+/).filter(term => term.length > 2);
	}

	private buildLinkDistanceMap(activeFilePath: string): Map<string, number> {
		const distances = new Map<string, number>();
		const resolvedLinks = this.app.metadataCache.resolvedLinks as Record<string, Record<string, number>> | undefined;
		if (!resolvedLinks) {
			return distances;
		}

		const adjacency = new Map<string, Set<string>>();
		const ensureNode = (path: string): void => {
			if (!adjacency.has(path)) {
				adjacency.set(path, new Set());
			}
		};
		const addEdge = (from: string, to: string): void => {
			ensureNode(from);
			ensureNode(to);
			adjacency.get(from)!.add(to);
			adjacency.get(to)!.add(from);
		};

		for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
			const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
			if (!(sourceFile instanceof TFile) || sourceFile.extension !== 'md') {
				continue;
			}
			for (const targetPath of Object.keys(targets || {})) {
				const targetFile = this.app.vault.getAbstractFileByPath(targetPath);
				if (!(targetFile instanceof TFile) || targetFile.extension !== 'md') {
					continue;
				}
				addEdge(sourcePath, targetPath);
			}
		}

		if (!adjacency.has(activeFilePath)) {
			return distances;
		}

		const queue: string[] = [activeFilePath];
		distances.set(activeFilePath, 0);

		while (queue.length > 0) {
			const current = queue.shift()!;
			const currentDistance = distances.get(current)!;
			if (currentDistance >= 6) {
				continue;
			}

			for (const neighbor of adjacency.get(current) || []) {
				if (!distances.has(neighbor)) {
					distances.set(neighbor, currentDistance + 1);
					queue.push(neighbor);
				}
			}
		}

		return distances;
	}

	private calculateFolderProximity(activeFile: TFile | null, candidate: TFile): number {
		if (!activeFile) {
			return 0;
		}

		const activeFolder = activeFile.parent?.path || '';
		const candidateFolder = candidate.parent?.path || '';
		if (!activeFolder || !candidateFolder) {
			return 0;
		}
		if (activeFolder === candidateFolder) {
			return 1;
		}

		const activeParts = activeFolder.split('/').filter(Boolean);
		const candidateParts = candidateFolder.split('/').filter(Boolean);
		let shared = 0;
		for (let i = 0; i < Math.min(activeParts.length, candidateParts.length); i++) {
			if (activeParts[i] !== candidateParts[i]) {
				break;
			}
			shared++;
		}

		if (shared === 0) {
			return 0;
		}

		return shared / Math.max(activeParts.length, candidateParts.length);
	}

	private async rerankResultsWithGraphSignals(results: SearchResult[]): Promise<SearchResult[]> {
		if (results.length === 0) {
			return results;
		}

		const resolvedSettings = this.resolveGraphRerankSettings();
		const semanticBonusCap = Math.max(0, Math.min(1, resolvedSettings.graphWeightSemantic));
		const rawNonSemanticWeights = {
			backlinkDistance: Math.max(0, resolvedSettings.graphWeightBacklinkDistance),
			recency: Math.max(0, resolvedSettings.graphWeightRecency),
			bookmarked: Math.max(0, resolvedSettings.graphWeightBookmarked),
			folder: Math.max(0, resolvedSettings.graphWeightFolderProximity)
		};
		const rawNonSemanticWeightSum =
			rawNonSemanticWeights.backlinkDistance +
			rawNonSemanticWeights.recency +
			rawNonSemanticWeights.bookmarked +
			rawNonSemanticWeights.folder;
		const normalizedNonSemanticWeights = rawNonSemanticWeightSum > 0
			? {
				backlinkDistance: rawNonSemanticWeights.backlinkDistance / rawNonSemanticWeightSum,
				recency: rawNonSemanticWeights.recency / rawNonSemanticWeightSum,
				bookmarked: rawNonSemanticWeights.bookmarked / rawNonSemanticWeightSum,
				folder: rawNonSemanticWeights.folder / rawNonSemanticWeightSum
			}
			: {
				backlinkDistance: this.defaultGraphWeightBacklinkDistance,
				recency: this.defaultGraphWeightRecency,
				bookmarked: this.defaultGraphWeightBookmarked,
				folder: this.defaultGraphWeightFolderProximity
			};

		const activeFile = this.resolvePreferredMarkdownFile();
		const activePath = activeFile?.path;
		const distanceMap = activePath ? this.buildLinkDistanceMap(activePath) : new Map<string, number>();
		const bookmarked = await this.getBookmarkedMarkdownFiles(200);
		const bookmarkedPaths = new Set(bookmarked.map(file => file.path));

		const halfLifeDays = resolvedSettings.graphRecencyHalfLifeDays;
		const lambda = Math.log(2) / halfLifeDays;

		const reranked = results.map(result => {
			const semantic = Math.max(0, Math.min(1, result.relevance));
			const distance = distanceMap.get(result.path);
			const backlinkDistanceScore = distance === undefined ? 0 : (1 / (1 + distance));
			const daysSinceModified = Math.max(0, (Date.now() - result.file.stat.mtime) / (1000 * 60 * 60 * 24));
			const recencyScore = Math.exp(-lambda * daysSinceModified);
			const bookmarkedScore = bookmarkedPaths.has(result.path) ? 1 : 0;
			const folderScore = this.calculateFolderProximity(activeFile, result.file);

			const nonSemanticScore =
				(normalizedNonSemanticWeights.backlinkDistance * backlinkDistanceScore) +
				(normalizedNonSemanticWeights.recency * recencyScore) +
				(normalizedNonSemanticWeights.bookmarked * bookmarkedScore) +
				(normalizedNonSemanticWeights.folder * folderScore);
			const additiveBonus = semanticBonusCap * (1 - semantic) * nonSemanticScore;
			const rawWeightedScore = semantic + additiveBonus;
			const finalScore = Math.max(0, Math.min(1, rawWeightedScore));

			return {
				...result,
				relevance: finalScore,
				graphDebug: {
					semantic,
					backlinkDistanceScore,
					recencyScore,
					bookmarkedScore,
					folderScore,
					backlinkDistanceRaw: distance ?? null,
					daysSinceModified,
					weights: {
						semantic: 1,
						backlinkDistance: semanticBonusCap * normalizedNonSemanticWeights.backlinkDistance,
						recency: semanticBonusCap * normalizedNonSemanticWeights.recency,
						bookmarked: semanticBonusCap * normalizedNonSemanticWeights.bookmarked,
						folder: semanticBonusCap * normalizedNonSemanticWeights.folder
					},
					rawWeightedScore,
					normalizedScore: finalScore
				}
			};
		});

		reranked.sort((a, b) => b.relevance - a.relevance);

		if (resolvedSettings.enableDeveloperLogging && reranked.length > 0) {
			const sample = reranked.slice(0, Math.min(3, reranked.length)).map(item => ({
				path: item.path,
				relevance: item.relevance,
				anchorTarget: item.anchorTarget,
				graphDebug: item.graphDebug
			}));
			LoggingUtility.log('Graph reranker top candidates', sample);
		}

		return reranked;
	}

	private estimateTokenCount(text: string): number {
		if (!text) return 0;
		const words = text.trim().split(/\s+/).filter(Boolean).length;
		const byWords = Math.ceil(words * 1.4);
		const byChars = Math.ceil(text.length / 4);
		return Math.max(byWords, byChars);
	}

	private clipTextToTokenBudget(text: string, maxTokens: number): string {
		if (!text || maxTokens <= 0) return '';
		if (this.estimateTokenCount(text) <= maxTokens) {
			return text;
		}

		const hardCharBudget = Math.max(120, maxTokens * 4);
		let clipped = text.slice(0, hardCharBudget);
		const lastBoundary = Math.max(clipped.lastIndexOf('\n\n'), clipped.lastIndexOf('. '), clipped.lastIndexOf(' '));
		if (lastBoundary > 80) {
			clipped = clipped.slice(0, lastBoundary);
		}

		return clipped.trimEnd() + '...';
	}

	private packResultsToTokenBudget(results: SearchResult[], maxTokens: number, maxResults: number): SearchResult[] {
		if (results.length === 0) {
			return [];
		}

		if (maxTokens <= 0) {
			return results.slice(0, maxResults);
		}

		const sorted = [...results].sort((a, b) => b.relevance - a.relevance);
		const used = new Set<string>();
		const selected: SearchResult[] = [];
		let usedTokens = 0;

		const firstPassByFile = new Map<string, SearchResult>();
		for (const result of sorted) {
			if (!firstPassByFile.has(result.path)) {
				firstPassByFile.set(result.path, result);
			}
		}

		const tryAdd = (result: SearchResult): void => {
			if (selected.length >= maxResults) return;
			const key = `${result.path}::${result.paragraphIndex ?? -1}::${result.content.slice(0, 80)}`;
			if (used.has(key)) return;

			const remaining = maxTokens - usedTokens;
			if (remaining <= 50) return;

			let finalContent = result.content;
			let estimated = this.estimateTokenCount(finalContent);
			if (estimated > remaining) {
				finalContent = this.clipTextToTokenBudget(finalContent, remaining);
				estimated = this.estimateTokenCount(finalContent);
			}

			if (!finalContent.trim()) return;
			if (estimated > remaining) return;

			selected.push({ ...result, content: finalContent });
			usedTokens += estimated;
			used.add(key);
		};

		for (const result of firstPassByFile.values()) {
			tryAdd(result);
			if (selected.length >= maxResults || usedTokens >= maxTokens) break;
		}

		for (const result of sorted) {
			tryAdd(result);
			if (selected.length >= maxResults || usedTokens >= maxTokens) break;
		}

		if (selected.length === 0 && sorted.length > 0) {
			const fallbackBudget = Math.max(80, Math.min(maxTokens, Math.floor(maxTokens * 0.9)));
			const fallback = sorted[0];
			selected.push({
				...fallback,
				content: this.clipTextToTokenBudget(fallback.content, fallbackBudget)
			});
		}

		return selected;
	}

	private async expandResultsWithNeighborContext(results: SearchResult[], maxTokensPerResult: number): Promise<SearchResult[]> {
		if (results.length === 0 || maxTokensPerResult <= 0) {
			return results;
		}

		const fileContentCache = new Map<string, string>();
		const expandedResults: SearchResult[] = [];

		for (const result of results) {
			const baseClipped = this.clipTextToTokenBudget(result.content, maxTokensPerResult);
			let expandedContent = baseClipped;

			try {
				let fileContent = fileContentCache.get(result.path);
				if (!fileContent) {
					fileContent = await this.app.vault.cachedRead(result.file);
					fileContentCache.set(result.path, fileContent);
				}

				const paragraphs = fileContent
					.split(/\n\s*\n+/)
					.map(p => p.trim())
					.filter(Boolean);

				if (paragraphs.length > 0) {
					const anchorSnippet = result.content.replace(/\s+/g, ' ').trim().slice(0, 160).toLowerCase();
					const anchorIndex = paragraphs.findIndex(paragraph => {
						const norm = paragraph.replace(/\s+/g, ' ').toLowerCase();
						return norm.includes(anchorSnippet) || anchorSnippet.includes(norm.slice(0, Math.min(norm.length, 60)));
					});

					if (anchorIndex >= 0) {
						const selectedParagraphs: string[] = [paragraphs[anchorIndex]];
						let used = this.estimateTokenCount(selectedParagraphs[0]);
						let offset = 1;

						while (used < maxTokensPerResult && (anchorIndex - offset >= 0 || anchorIndex + offset < paragraphs.length)) {
							let addedAny = false;

							if (anchorIndex - offset >= 0) {
								const prev = paragraphs[anchorIndex - offset];
								const prevTokens = this.estimateTokenCount(prev);
								if (used + prevTokens <= maxTokensPerResult) {
									selectedParagraphs.unshift(prev);
									used += prevTokens;
									addedAny = true;
								}
							}

							if (anchorIndex + offset < paragraphs.length) {
								const next = paragraphs[anchorIndex + offset];
								const nextTokens = this.estimateTokenCount(next);
								if (used + nextTokens <= maxTokensPerResult) {
									selectedParagraphs.push(next);
									used += nextTokens;
									addedAny = true;
								}
							}

							if (!addedAny) {
								break;
							}

							offset++;
						}

						expandedContent = this.clipTextToTokenBudget(selectedParagraphs.join('\n\n'), maxTokensPerResult);
					}
				}
			} catch (error) {
				LoggingUtility.warn(`Unable to expand neighbor context for ${result.path}:`, error);
			}

			expandedResults.push({ ...result, content: expandedContent });
		}

		return expandedResults;
	}

	private calculateMetadataRelevance(queryTerms: string[], metadata: CachedMetadata | null, file: TFile): number {
		const fileName = file.basename.toLowerCase();
		const filePath = file.path.toLowerCase();
		let score = 0;

		for (const term of queryTerms) {
			if (fileName.includes(term)) {
				score += 10;
			}

			if (filePath.includes(term)) {
				score += 5;
			}

			if (metadata?.tags?.some(tag => tag.tag.toLowerCase().includes(term))) {
				score += 3;
			}

			if (metadata?.frontmatter) {
				const frontmatterStr = JSON.stringify(metadata.frontmatter).toLowerCase();
				if (frontmatterStr.includes(term)) {
					score += 2;
				}
			}

			if (metadata?.headings?.some(heading => heading.heading.toLowerCase().includes(term))) {
				score += 2;
			}
		}

		return score;
	}

	/**
	 * Extract the most relevant content from a file
	 */
	private extractRelevantContent(content: string, query: string, maxTokens: number): string {
		const lines = content.split('\n');
		const queryTerms = this.extractQueryTerms(query);
		
		// Score each line based on query relevance
		const scoredLines = lines.map((line, index) => {
			const lineLower = line.toLowerCase();
			let score = 0;
			
			for (const term of queryTerms) {
				if (lineLower.includes(term)) {
					score += 1;
				}
			}
			
			// Bonus for headings
			if (line.startsWith('#')) {
				score += 2;
			}
			
			// Bonus for lines near other relevant lines
			const nearbyRelevant = lines.slice(Math.max(0, index - 2), index + 3)
				.some(nearbyLine => {
					const nearbyLower = nearbyLine.toLowerCase();
					return queryTerms.some(term => nearbyLower.includes(term));
				});
			
			if (nearbyRelevant) {
				score += 0.5;
			}
			
			return { line, score, index };
		});
		
		// Sort by score and take top lines
		scoredLines.sort((a, b) => b.score - a.score);
		
		// Reconstruct content from top-scoring lines, maintaining order
		const selectedIndices = scoredLines
			.slice(0, Math.ceil(maxTokens / 50)) // Rough estimate: 50 tokens per line
			.map(item => item.index)
			.sort((a, b) => a - b);
		
		const selectedLines = selectedIndices.map(index => lines[index]);
		let result = selectedLines.join('\n');
		
		// Truncate if too long (rough token estimation)
		if (result.length > maxTokens * 4) { // Rough estimate: 4 characters per token
			result = result.substring(0, maxTokens * 4) + '...';
		}
		
		return result;
	}

	/**
	 * Get a readable title for the file
	 */
	private getFileTitle(file: TFile, metadata: CachedMetadata | null): string {
		// Try to get title from frontmatter
		if (typeof metadata?.frontmatter?.title === 'string' && metadata.frontmatter.title.length > 0) {
			return metadata.frontmatter.title;
		}
		
		// Try to get title from first heading
		if (metadata?.headings && metadata.headings.length > 0) {
			const heading = metadata.headings[0]?.heading;
			if (typeof heading === 'string' && heading.length > 0) {
				return heading;
			}
		}
		
		// Fall back to filename
		return file.basename;
	}

	/**
	 * Format search results for inclusion in LLM context
	 */
	formatSearchResults(results: SearchResult[], maxTokens?: number): string {
		if (results.length === 0) {
			return '';
		}

		const budget = maxTokens && maxTokens > 0 ? maxTokens : Number.MAX_SAFE_INTEGER;
		// Keep each note excerpt bounded so high global budgets do not inject whole notes.
		const perResultCap = Math.max(120, Math.min(480, Math.floor(budget / Math.max(results.length, 1))));
		let usedTokens = this.estimateTokenCount('\n\n--- RELEVANT OBSIDIAN NOTES ---\n\n');
		let context = '\n\n--- RELEVANT OBSIDIAN NOTES ---\n\n';

		for (const result of results) {
			if (usedTokens >= budget) {
				break;
			}

			const citationPath = result.anchorTarget ? `${result.path}${result.anchorTarget}` : result.path;
			const headingLine = result.headingPath ? `Heading: ${result.headingPath}\n` : '';
			const header = `**${result.title}** (${result.path})\nCite: ${citationPath}\n${headingLine}Relevance: ${(result.relevance * 100).toFixed(1)}%\n\n`;
			const headerTokens = this.estimateTokenCount(header);
			if (usedTokens + headerTokens >= budget) {
				break;
			}

			const remainingForBody = budget - usedTokens - headerTokens - this.estimateTokenCount('\n\n---\n\n');
			if (remainingForBody <= 20) {
				break;
			}

			const noteBudget = Math.min(remainingForBody, perResultCap);
			const clippedContent = this.clipTextToTokenBudget(result.content, noteBudget);
			const bodyTokens = this.estimateTokenCount(clippedContent);
			if (bodyTokens <= 0) {
				continue;
			}

			context += header;
			context += clippedContent + '\n\n';
			context += '---\n\n';
			usedTokens += headerTokens + bodyTokens + this.estimateTokenCount('\n\n---\n\n');
		}

		return context;
	}

	/**
	 * Get all open markdown notes as context
	 */
	async getCurrentNoteContext(): Promise<SearchResult[]> {
		try {
			// Get all open leaves
			const leaves = this.app.workspace.getLeavesOfType('markdown');
			const openMarkdownFiles: TFile[] = [];

					// Collect all open markdown files
		for (const leaf of leaves) {
			if (leaf.view instanceof MarkdownView) {
				const file = leaf.view.file;
				if (file && file.extension === 'md') {
					openMarkdownFiles.push(file);
				}
			}
		}

					// Also check the active view in case it's not in the markdown leaves
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView) {
			const activeFile = activeView.file;
			if (activeFile && activeFile.extension === 'md' && !openMarkdownFiles.some(f => f.path === activeFile.path)) {
				openMarkdownFiles.push(activeFile);
			}
		}

			if (openMarkdownFiles.length === 0) {
				LoggingUtility.log('No open markdown files found');
				return [];
			}

			LoggingUtility.log(`Found ${openMarkdownFiles.length} open markdown files:`, openMarkdownFiles.map(f => f.path));

			// Create search results for all open files
			const results: SearchResult[] = [];
			for (const file of openMarkdownFiles) {
				try {
					const content = await this.app.vault.cachedRead(file);
					const metadata = this.app.metadataCache.getFileCache(file);
					
					results.push({
						file,
						content: content,
						relevance: 1.0, // Full relevance since they're open
						title: this.getFileTitle(file, metadata),
						path: file.path
					});
				} catch (error) {
					LoggingUtility.error(`Error reading file ${file.path}:`, error);
				}
			}

			return results;

		} catch (error) {
			LoggingUtility.error('Error getting current note context:', error);
			return [];
		}
	}

	/**
	 * Get only the active markdown note as context.
	 */
	async getActiveNoteContext(): Promise<SearchResult[]> {
		const activeFile = this.resolvePreferredMarkdownFile();
		if (!activeFile || activeFile.extension !== 'md') {
			return [];
		}

		return this.getContextFromFiles([activeFile], () => 1.0);
	}

	/**
	 * Get markdown files linked to the current note (outgoing + backlinks).
	 */
	async getLinkedNotesFiles(maxResults: number = 40): Promise<TFile[]> {
		try {
			const activeFile = this.resolvePreferredMarkdownFile();
			if (!activeFile || activeFile.extension !== 'md') {
				return [];
			}

			const linked = new Map<string, number>();
			const links = this.app.metadataCache.resolvedLinks?.[activeFile.path] || {};
			for (const [path, count] of Object.entries(links)) {
				linked.set(path, Math.max(1, Number(count) || 1));
			}

			const backlinks: Record<string, Record<string, number>> = this.app.metadataCache.unresolvedLinks || {};
			for (const [sourcePath, targets] of Object.entries(backlinks)) {
				if (sourcePath === activeFile.path) {
					continue;
				}
				if (targets && Object.keys(targets).some(target => target === activeFile.path || target.endsWith('/' + activeFile.path))) {
					linked.set(sourcePath, Math.max(linked.get(sourcePath) || 0, 1));
				}
			}

			const files: TFile[] = [];
			for (const path of linked.keys()) {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile && file.extension === 'md') {
					files.push(file);
				}
			}

			files.sort((a, b) => b.stat.mtime - a.stat.mtime);
			return files.slice(0, maxResults);
		} catch (error) {
			LoggingUtility.error('Error getting linked notes files:', error);
			return [];
		}
	}

	/**
	 * Get markdown files in the same folder as the active note.
	 */
	async getCurrentFolderFiles(maxResults: number = 50): Promise<TFile[]> {
		try {
			const activeFile = this.resolvePreferredMarkdownFile();
			if (!activeFile || activeFile.extension !== 'md') {
				return [];
			}

			const folderPrefix = activeFile.parent?.path ? `${activeFile.parent.path}/` : '';
			const files = this.app.vault.getMarkdownFiles().filter(file => {
				if (folderPrefix) {
					return file.path.startsWith(folderPrefix);
				}
				return !file.path.includes('/');
			});
			files.sort((a, b) => b.stat.mtime - a.stat.mtime);
			return files.slice(0, maxResults);
		} catch (error) {
			LoggingUtility.error('Error getting current folder files:', error);
			return [];
		}
	}

	/**
	 * Get markdown files that likely represent daily notes.
	 */
	async getDailyNotesFiles(maxResults: number = 20): Promise<TFile[]> {
		try {
			const files = this.app.vault.getMarkdownFiles().filter(file => this.isLikelyDailyNote(file));
			files.sort((a, b) => b.stat.mtime - a.stat.mtime);
			return files.slice(0, maxResults);
		} catch (error) {
			LoggingUtility.error('Error getting daily notes files:', error);
			return [];
		}
	}

	/**
	 * Get notes linked to the current note (outgoing + backlinks).
	 */
	async getLinkedNotesContext(maxResults: number = 40): Promise<SearchResult[]> {
		try {
			const files = await this.getLinkedNotesFiles(maxResults);
			return this.getContextFromFiles(files, () => 1.0);
		} catch (error) {
			LoggingUtility.error('Error getting linked notes context:', error);
			return [];
		}
	}

	/**
	 * Get markdown notes in the same folder as the active note.
	 */
	async getCurrentFolderContext(maxResults: number = 50): Promise<SearchResult[]> {
		try {
			const files = await this.getCurrentFolderFiles(maxResults);
			return this.getContextFromFiles(files, () => 1.0);
		} catch (error) {
			LoggingUtility.error('Error getting current folder context:', error);
			return [];
		}
	}

	/**
	 * Get likely daily notes (date-like titles or daily-notes folder path).
	 */
	async getDailyNotesContext(maxResults: number = 20): Promise<SearchResult[]> {
		try {
			const files = await this.getDailyNotesFiles(maxResults);
			return this.getContextFromFiles(files, () => 1.0);
		} catch (error) {
			LoggingUtility.error('Error getting daily notes context:', error);
			return [];
		}
	}

	/**
	 * Get bookmarked markdown files from Obsidian's bookmarks plugin.
	 */
	async getBookmarkedMarkdownFiles(maxResults: number = 60): Promise<TFile[]> {
		try {
			const bookmarkedPaths = new Set<string>();
			const appWithInternalPlugins = this.app as unknown as AppWithInternalPlugins;
			const bookmarksItems = appWithInternalPlugins.internalPlugins?.plugins?.bookmarks?.instance?.items;

			const collectBookmarkPaths = (items: BookmarkItem[] | undefined): void => {
				if (!items) return;
				for (const item of items) {
					if (!item) continue;
					if (item.type === 'file' && typeof item.path === 'string') {
						bookmarkedPaths.add(item.path);
					}
					if (Array.isArray(item.items)) {
						collectBookmarkPaths(item.items);
					}
				}
			};

			collectBookmarkPaths(bookmarksItems);

			if (bookmarkedPaths.size === 0) {
				return [];
			}

			const files: TFile[] = [];
			for (const path of bookmarkedPaths) {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile && file.extension === 'md') {
					files.push(file);
				}
			}

			files.sort((a, b) => b.stat.mtime - a.stat.mtime);
			return files.slice(0, maxResults);
		} catch (error) {
			LoggingUtility.error('Error getting bookmarked markdown files:', error);
			return [];
		}
	}

	/**
	 * Get bookmarked markdown notes.
	 */
	async getBookmarkedNotesContext(maxResults: number = 60): Promise<SearchResult[]> {
		try {
			const files = await this.getBookmarkedMarkdownFiles(maxResults);
			return this.getContextFromFiles(files, () => 1.0);
		} catch (error) {
			LoggingUtility.error('Error getting bookmarked notes context:', error);
			return [];
		}
	}

	/**
	 * Resolve a file scope from a free-text search query.
	 */
	async getFilesForScopeQuery(scopeQuery: string, maxFiles: number = 60): Promise<TFile[]> {
		const terms = this.extractQueryTerms(scopeQuery);
		if (terms.length === 0) {
			return [];
		}

		const files = this.app.vault.getMarkdownFiles();
		const scored = files
			.map(file => {
				const metadata = this.app.metadataCache.getFileCache(file);
				const score = this.calculateMetadataRelevance(terms, metadata, file);
				return { file, score };
			})
			.filter(item => item.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, maxFiles)
			.map(item => item.file);

		return scored;
	}

	private isLikelyDailyNote(file: TFile): boolean {
		const dailyPathPattern = /(\/|^)daily\s*notes?\//i;
		const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
		const shortDatePattern = /^\d{4}[/.]\d{2}[/.]\d{2}$/;

		return dailyPathPattern.test(file.path) || isoDatePattern.test(file.basename) || shortDatePattern.test(file.basename);
	}

	private async getContextFromFiles(files: TFile[], relevanceResolver?: (file: TFile, index: number) => number): Promise<SearchResult[]> {
		const deduped = Array.from(new Map(files.map(file => [file.path, file])).values());
		const results: SearchResult[] = [];

		for (let index = 0; index < deduped.length; index++) {
			const file = deduped[index];
			try {
				const content = await this.app.vault.cachedRead(file);
				const metadata = this.app.metadataCache.getFileCache(file);
				results.push({
					file,
					content,
					relevance: relevanceResolver ? Math.max(0.1, Math.min(1, relevanceResolver(file, index))) : 1.0,
					title: this.getFileTitle(file, metadata),
					path: file.path
				});
			} catch (error) {
				LoggingUtility.error(`Error reading scoped context file ${file.path}:`, error);
			}
		}

		return results;
	}

	/**
	 * Get notes from the last 7 days as context
	 */
	async getRecentNotesContext(): Promise<SearchResult[]> {
		try {
			const sevenDaysAgo = new Date();
			sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
			
			LoggingUtility.log(`Getting notes from the last 7 days (since ${sevenDaysAgo.toDateString()})`);

			// Get all markdown files
			const allFiles = this.app.vault.getMarkdownFiles();
			const recentFiles: TFile[] = [];

			// Filter files by modification time in the last 7 days
			for (const file of allFiles) {
				if (file.stat.mtime >= sevenDaysAgo.getTime()) {
					recentFiles.push(file);
				}
			}

			if (recentFiles.length === 0) {
				LoggingUtility.log('No notes found from the last 7 days');
				return [];
			}

			LoggingUtility.log(`Found ${recentFiles.length} notes from the last 7 days:`, recentFiles.map(f => f.path));

			// Sort by modification time (most recent first)
			recentFiles.sort((a, b) => b.stat.mtime - a.stat.mtime);

			// Create search results for recent files
			const results: SearchResult[] = [];
			for (const file of recentFiles) {
				try {
					const content = await this.app.vault.cachedRead(file);
					const metadata = this.app.metadataCache.getFileCache(file);
					
					// Calculate relevance based on recency (more recent = higher relevance)
					const daysSinceModified = (Date.now() - file.stat.mtime) / (1000 * 60 * 60 * 24);
					const relevance = Math.max(0.1, 1 - (daysSinceModified / 7)); // Scale from 1.0 (today) to 0.1 (7 days ago)
					
					results.push({
						file,
						content: content,
						relevance: relevance,
						title: this.getFileTitle(file, metadata),
						path: file.path
					});
				} catch (error) {
					LoggingUtility.error(`Error reading file ${file.path}:`, error);
				}
			}

			return results;

		} catch (error) {
			LoggingUtility.error('Error getting recent notes context:', error);
			return [];
		}
	}
} 
