import { LoggingUtility } from '../utils/LoggingUtility';
import { requestUrl } from 'obsidian';

interface EmbeddingRequest {
	input: string | string[];
	model?: string;
	// llama.cpp/openai-compatible servers can cache prompts by default.
	// Disable it for embeddings to avoid unbounded prompt-cache growth.
	cache_prompt?: boolean;
}

interface EmbeddingResponse {
	data: Array<{
		embedding: number[];
		index: number;
	}>;
	model: string;
	usage: {
		prompt_tokens: number;
		total_tokens: number;
	};
}

function isEmbeddingResponse(value: unknown): value is EmbeddingResponse {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const candidate = value as { data?: unknown };
	if (!Array.isArray(candidate.data)) {
		return false;
	}

	return candidate.data.every((entry) => {
		if (!entry || typeof entry !== 'object') {
			return false;
		}

		const item = entry as { embedding?: unknown; index?: unknown };
		return Array.isArray(item.embedding)
			&& item.embedding.every((n) => typeof n === 'number')
			&& typeof item.index === 'number';
	});
}

export interface EmbeddingConfig {
	endpoint: string;
	model: string;
	apiKey?: string;
	// Request timeout for embedding API calls in milliseconds. Default: 30000.
	timeoutMs?: number;
	// Maximum tokens allowed per input sent to the embedding server. If a text
	// exceeds this, it will be chunked client-side. Default: 512.
	maxInputTokens?: number;
	// Number of tokens to overlap between adjacent chunks. Default: 20.
	chunkOverlapTokens?: number;
	// How to combine chunk embeddings when a single-vector result is required.
	// 'storeChunks' means return the first chunk embedding and caller should store chunks separately.
	// 'average' will element-wise average chunk embeddings into one vector.
	chunkCombineStrategy?: 'storeChunks' | 'average' | 'first';
	// Max number of inputs to include in a single embeddings request (batch size).
		maxInputsPerRequest?: number;
	// Maximum combined estimated tokens to include in one batched request.
	maxTokensPerRequest?: number;
}

export class EmbeddingService {
	private config: EmbeddingConfig;
	private runtimeMaxInputTokens?: number;
	private runtimeLimitsChecked = false;
	private runtimeLimitCheckPromise?: Promise<void>;

	constructor(config: EmbeddingConfig) {
		this.config = config;
	}

	/** Get configured max tokens, defaulting to 512 */
	private getMaxInputTokens(): number {
		const configured = this.config.maxInputTokens ?? 512;
		if (typeof this.runtimeMaxInputTokens === 'number' && this.runtimeMaxInputTokens > 0) {
			return Math.max(32, Math.min(configured, this.runtimeMaxInputTokens));
		}
		return configured;
	}

	/** Get configured overlap tokens, defaulting to 20 */
	private getChunkOverlap(): number {
		return this.config.chunkOverlapTokens ?? 20;
	}

	/** Get chunk combine strategy */
	private getChunkCombineStrategy(): 'storeChunks' | 'average' | 'first' {
		return this.config.chunkCombineStrategy ?? 'storeChunks';
	}

	/** Get max inputs per request (batch size) */
	private getMaxInputsPerRequest(): number {
		return this.config.maxInputsPerRequest ?? 8;
	}

	/** Get max combined tokens allowed per batched request */
	private getMaxTokensPerRequest(): number {
		return this.config.maxTokensPerRequest ?? 768;
	}

	/** Get request timeout in milliseconds */
	private getRequestTimeoutMs(): number {
		return this.config.timeoutMs ?? 30000;
	}

	/**
	 * Approximate token count. Prefer a real tokenizer for exact counts.
	 * This fallback is intentionally conservative to avoid server-side hard caps.
	 */
	private countTokens(text: string): number {
		if (!text) return 0;
		const words = text.trim().split(/\s+/).length;
		const byWords = Math.ceil(words * 1.6);
		const byChars = Math.ceil(text.length / 3);
		return Math.max(byWords, byChars);
	}

	private isInputTooLargeError(message: string): boolean {
		const m = message.toLowerCase();
		return m.includes('input (') && m.includes('tokens) is too large');
	}

	private isTimeoutLikeError(message: string): boolean {
		const m = message.toLowerCase();
		return m.includes('timed out') || m.includes('etimedout') || m.includes('timeout exceeded');
	}

	private shouldSplitAndRetry(message: string): boolean {
		return this.isInputTooLargeError(message) || this.isTimeoutLikeError(message);
	}

	private splitTextInHalf(text: string): [string, string] {
		const normalized = text.trim();
		if (normalized.length <= 2) {
			const mid = Math.max(1, Math.floor(normalized.length / 2));
			return [normalized.slice(0, mid), normalized.slice(mid)];
		}

		const mid = Math.floor(normalized.length / 2);
		const leftSpace = normalized.lastIndexOf(' ', mid);
		const rightSpace = normalized.indexOf(' ', mid);
		let splitIdx = mid;
		if (leftSpace > 0 && rightSpace > 0) {
			splitIdx = (mid - leftSpace <= rightSpace - mid) ? leftSpace : rightSpace;
		} else if (leftSpace > 0) {
			splitIdx = leftSpace;
		} else if (rightSpace > 0) {
			splitIdx = rightSpace;
		}

		const first = normalized.slice(0, splitIdx).trim();
		const second = normalized.slice(splitIdx).trim();
		if (!first || !second) {
			const fallbackMid = Math.max(1, Math.floor(normalized.length / 2));
			return [normalized.slice(0, fallbackMid), normalized.slice(fallbackMid)];
		}
		return [first, second];
	}

	private splitChunkToFit(text: string, maxTokens: number): string[] {
		const result: string[] = [];
		const queue: string[] = [text.trim()];

		while (queue.length > 0) {
			const current = queue.shift()?.trim() ?? '';
			if (!current) continue;

			if (this.countTokens(current) <= maxTokens) {
				result.push(current);
				continue;
			}

			const [left, right] = this.splitTextInHalf(current);
			if (!left || !right || left === current || right === current) {
				const splitByChars = Math.max(1, Math.floor(current.length / 2));
				queue.unshift(current.slice(splitByChars));
				queue.unshift(current.slice(0, splitByChars));
				continue;
			}

			queue.unshift(right);
			queue.unshift(left);
		}

		return result;
	}

	/**
	 * Chunk text into pieces where each piece has approximately <= maxTokens tokens.
	 * This uses conservative token checks while building each chunk.
	 */
	private chunkText(text: string, maxTokens: number, overlapTokens: number): string[] {
		if (!text) return [];
		const normalized = text.trim();
		if (!normalized) return [];

		const effectiveMaxTokens = Math.max(32, Math.floor(maxTokens * 0.7));
		const effectiveOverlap = Math.max(0, Math.min(overlapTokens, effectiveMaxTokens - 1));
		if (this.countTokens(normalized) <= effectiveMaxTokens) return [normalized];

		const words = normalized.split(/\s+/).filter(Boolean);
		if (words.length === 0) return [];

		const chunks: string[] = [];
		let start = 0;
		while (start < words.length) {
			let end = start;
			let candidate = '';

			while (end < words.length) {
				const nextCandidate = candidate ? `${candidate} ${words[end]}` : words[end];
				if (candidate && this.countTokens(nextCandidate) > effectiveMaxTokens) {
					break;
				}
				candidate = nextCandidate;
				end++;
			}

			if (!candidate) {
				chunks.push(...this.splitChunkToFit(words[start], effectiveMaxTokens));
				start++;
				continue;
			}

			chunks.push(...this.splitChunkToFit(candidate, effectiveMaxTokens));

			if (end >= words.length) break;
			const wordsInChunk = Math.max(1, end - start);
			const overlapWords = Math.min(effectiveOverlap, wordsInChunk - 1);
			start += Math.max(1, wordsInChunk - overlapWords);
		}

		return chunks.filter(chunk => chunk.trim().length > 0);
	}

	/** Element-wise average of embeddings */
	private averageEmbeddings(embs: number[][]): number[] {
		if (!embs || embs.length === 0) return [];
		const dim = embs[0].length;
		const out = new Array<number>(dim).fill(0);
		for (const e of embs) {
			if (e.length !== dim) throw new Error('Mismatched embedding dimensions when averaging');
			for (let i = 0; i < dim; i++) out[i] += e[i];
		}
		for (let i = 0; i < dim; i++) out[i] /= embs.length;
		return out;
	}

	private buildHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};

		if (this.config.apiKey && this.config.apiKey.trim().length > 0) {
			headers.Authorization = `Bearer ${this.config.apiKey.trim()}`;
		}

		return headers;
	}

	private getErrorMessage(error: unknown): string {
		if (error instanceof Error) {
			return error.message;
		}
		return String(error);
	}

	private buildModelsEndpointFromEmbeddingEndpoint(): string {
		try {
			const url = new URL(this.config.endpoint);
			url.search = '';
			url.hash = '';

			if (url.pathname.includes('/v1/')) {
				url.pathname = url.pathname.replace(/\/v1\/.+$/, '/v1/models');
			} else {
				url.pathname = '/v1/models';
			}

			return url.toString();
		} catch {
			return this.config.endpoint.replace(/\/v1\/.+$/, '/v1/models');
		}
	}

	private extractRuntimeTokenLimit(payload: unknown): number | undefined {
		if (!payload || typeof payload !== 'object') return undefined;

		const asRecord = payload as Record<string, unknown>;
		const data = asRecord.data;
		if (!Array.isArray(data) || data.length === 0) return undefined;

		const numericFields = [
			'max_input_tokens',
			'maxInputTokens',
			'context_length',
			'contextLength',
			'n_ctx',
			'n_ctx_train',
			'max_seq_len',
			'embedding_ctx_length'
		];

		const extractFromObject = (obj: unknown): number | undefined => {
			if (!obj || typeof obj !== 'object') return undefined;
			const rec = obj as Record<string, unknown>;
			for (const field of numericFields) {
				const value = rec[field];
				if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
					return Math.floor(value);
				}
			}

			const nestedCandidates = [rec.metadata, rec.details, rec.info, rec.capabilities];
			for (const nested of nestedCandidates) {
				const nestedVal = extractFromObject(nested);
				if (typeof nestedVal === 'number') return nestedVal;
			}

			return undefined;
		};

		let selectedModel: Record<string, unknown> | undefined;
		for (const item of data) {
			if (!item || typeof item !== 'object') continue;
			const rec = item as Record<string, unknown>;
			if (typeof rec.id === 'string' && rec.id === this.config.model) {
				selectedModel = rec;
				break;
			}
		}

		if (selectedModel) {
			const direct = extractFromObject(selectedModel);
			if (typeof direct === 'number') return direct;
		}

		for (const item of data) {
			const candidate = extractFromObject(item);
			if (typeof candidate === 'number') return candidate;
		}

		return undefined;
	}

	private async ensureRuntimeLimits(): Promise<void> {
		if (this.runtimeLimitsChecked) return;
		if (this.runtimeLimitCheckPromise) {
			await this.runtimeLimitCheckPromise;
			return;
		}

		this.runtimeLimitCheckPromise = (async () => {
			try {
				const modelsEndpoint = this.buildModelsEndpointFromEmbeddingEndpoint();
				const response = await requestUrl({
					url: modelsEndpoint,
					method: 'GET',
					headers: this.buildHeaders(),
				});

				if (response.status >= 400) {
					LoggingUtility.warn(`Runtime limit discovery skipped (HTTP ${response.status})`);
					return;
				}

				const discovered = this.extractRuntimeTokenLimit(response.json);
				if (typeof discovered === 'number' && discovered > 0) {
					this.runtimeMaxInputTokens = discovered;
					LoggingUtility.log(`Discovered runtime embedding token limit: ${discovered}`);
				} else {
					LoggingUtility.log('Runtime embedding token limit not present in model metadata; using configured limit');
				}
			} catch (error) {
				LoggingUtility.warn('Runtime limit discovery failed; using configured embedding limits', this.getErrorMessage(error));
			} finally {
				this.runtimeLimitsChecked = true;
				this.runtimeLimitCheckPromise = undefined;
			}
		})();

		await this.runtimeLimitCheckPromise;
	}

	private async sendEmbeddingRequest(request: EmbeddingRequest): Promise<EmbeddingResponse> {
		const started = Date.now();
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeoutMs = this.getRequestTimeoutMs();
			const timeoutPromise = new Promise<never>((_, reject) => {
				timeoutHandle = setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
			});

			const response = await Promise.race([
				requestUrl({
					url: this.config.endpoint,
					method: 'POST',
					headers: this.buildHeaders(),
					body: JSON.stringify(request),
				}),
				timeoutPromise,
			]);

			if (response.status >= 400) {
				const errorText = response.text;
				LoggingUtility.error('Embedding API Error Response:', {
					status: response.status,
					durationMs: Date.now() - started,
					body: errorText,
				});
				throw new Error(`Embedding API request failed: ${response.status} - ${errorText}`);
			}

			const rawResponseData: unknown = response.json;
			if (!rawResponseData || typeof rawResponseData !== 'object') {
				throw new Error('Unexpected embedding response format');
			}

			const responseDataCandidate = rawResponseData as { data?: unknown };
			if (!Array.isArray(responseDataCandidate.data) || responseDataCandidate.data.length === 0) {
				throw new Error('No embedding data returned from API');
			}
			if (!isEmbeddingResponse(rawResponseData)) {
				throw new Error('Unexpected embedding response format');
			}
			const responseData = rawResponseData;

			LoggingUtility.log('Embedding request completed', {
				durationMs: Date.now() - started,
				status: response.status,
				results: responseData.data.length,
			});

			return responseData;
		} catch (error) {
			const msg = this.getErrorMessage(error);
			throw new Error(`Embedding request error (${this.getRequestTimeoutMs()}ms timeout): ${msg}`);
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
		}
	}

	/**
	 * Generate embeddings for a text
	 */
	async generateEmbedding(text: string, splitDepth: number = 0): Promise<number[]> {
		try {
			await this.ensureRuntimeLimits();
			// If text exceeds max tokens, chunk it and combine embeddings according
			// to the configured strategy.
			const maxTokens = this.getMaxInputTokens();
			const overlap = this.getChunkOverlap();
			if (this.countTokens(text) > maxTokens) {
				const chunks = this.chunkText(text, maxTokens, overlap);
				LoggingUtility.log(`Text token count exceeds ${maxTokens}, split into ${chunks.length} chunks`);
				// Get embeddings for each chunk
				const chunkEmbeddings = await this.generateEmbeddings(chunks);

				if (!chunkEmbeddings || chunkEmbeddings.length === 0) {
					throw new Error('No embedding data returned from API for chunks');
				}

				const strategy = this.getChunkCombineStrategy();
				if (strategy === 'average') {
					return this.averageEmbeddings(chunkEmbeddings);
				}
				if (strategy === 'first') {
					return chunkEmbeddings[0];
				}
				// 'storeChunks' or default: return first chunk embedding but caller
				// should store chunk embeddings separately for best retrieval quality.
				return chunkEmbeddings[0];
			}

			// Otherwise send single request as before
			const request: EmbeddingRequest = {
				input: text,
				model: this.config.model,
				cache_prompt: false
			};

			LoggingUtility.log('Generating embedding for text length:', text.length);

			try {
				const responseData = await this.sendEmbeddingRequest(request);

				const embedding = responseData.data[0].embedding;
				LoggingUtility.log(`Generated embedding with ${embedding.length} dimensions`);

				return embedding;
			} catch (requestError) {
				const errorText = this.getErrorMessage(requestError);
				if (this.shouldSplitAndRetry(errorText) && splitDepth < 8) {
					const [left, right] = this.splitTextInHalf(text);
					if (!left || !right) {
						throw requestError;
					}

					const leftEmbedding = await this.generateEmbedding(left, splitDepth + 1);
					const rightEmbedding = await this.generateEmbedding(right, splitDepth + 1);
					const strategy = this.getChunkCombineStrategy();
					if (strategy === 'first') return leftEmbedding;
					if (strategy === 'storeChunks') return leftEmbedding;
					return this.averageEmbeddings([leftEmbedding, rightEmbedding]);
				}
				throw requestError;
			}

		} catch (error) {
			LoggingUtility.error('Error generating embedding:', error);
			throw new Error(`Failed to generate embedding: ${this.getErrorMessage(error)}`);
		}
	}

	/**
	 * Generate embeddings for multiple texts
	 */
	async generateEmbeddings(texts: string[]): Promise<number[][]> {
		try {
			await this.ensureRuntimeLimits();
			const total = texts.length;
			LoggingUtility.log('Generating embeddings for', total, 'texts');

			const batchSize = this.getMaxInputsPerRequest();
			const maxBatchTokens = this.getMaxTokensPerRequest();
			if (total === 0) return [];

			const allEmbeddings: Array<number[] | null> = new Array(total).fill(null);
			const safeBatchTexts: string[] = [];
			const safeBatchIndices: number[] = [];

			// Route likely-oversized inputs through generateEmbedding(), which has
			// chunking and split-on-error fallback logic.
			const conservativeLimit = Math.max(32, Math.floor(this.getMaxInputTokens() * 0.7));
			for (let i = 0; i < total; i++) {
				const text = texts[i];
				if (this.countTokens(text) > conservativeLimit) {
					allEmbeddings[i] = await this.generateEmbedding(text);
				} else {
					safeBatchTexts.push(text);
					safeBatchIndices.push(i);
				}
			}

			if (safeBatchTexts.length > 0) {
				LoggingUtility.log(`Embedding ${safeBatchTexts.length} inputs via batched requests (batch size ${batchSize}, token budget ${maxBatchTokens})`);
			}

			for (let offset = 0; offset < safeBatchTexts.length; ) {
				let end = offset;
				let currentTokenBudget = 0;
				while (end < safeBatchTexts.length && (end - offset) < batchSize) {
					const nextTokens = this.countTokens(safeBatchTexts[end]);
					if (end > offset && (currentTokenBudget + nextTokens) > maxBatchTokens) {
						break;
					}
					currentTokenBudget += nextTokens;
					end++;
				}
				if (end === offset) {
					end = offset + 1;
				}

				const slice = safeBatchTexts.slice(offset, end);
				const sliceIndices = safeBatchIndices.slice(offset, end);
				const request: EmbeddingRequest = { input: slice, model: this.config.model, cache_prompt: false };

				LoggingUtility.log(`Sending embeddings request for batched items ${offset}-${offset + slice.length - 1} (approx ${currentTokenBudget} tokens)`);

				try {
					const responseData = await this.sendEmbeddingRequest(request);

					for (const item of responseData.data) {
						const itemIndex = typeof item.index === 'number' ? item.index : 0;
						const originalIndex = sliceIndices[itemIndex];
						if (typeof originalIndex === 'number') {
							allEmbeddings[originalIndex] = item.embedding;
						}
					}
				} catch (requestError) {
					const errorText = this.getErrorMessage(requestError);
					if (this.shouldSplitAndRetry(errorText)) {
						// Fallback: process each item individually so oversized entries can be split recursively.
						for (let i = 0; i < slice.length; i++) {
							allEmbeddings[sliceIndices[i]] = await this.generateEmbedding(slice[i]);
						}
						offset = end;
						continue;
					}
					throw requestError;
				}

				offset = end;
			}

			const missing = allEmbeddings.findIndex(e => e === null);
			if (missing !== -1) {
				throw new Error(`Missing embedding at index ${missing}`);
			}

			const embeddings = allEmbeddings as number[][];
			LoggingUtility.log(`Generated ${embeddings.length} embeddings with ${embeddings[0]?.length || 0} dimensions each`);
			return embeddings;

		} catch (error) {
			LoggingUtility.error('Error generating embeddings:', error);
			throw new Error(`Failed to generate embeddings: ${this.getErrorMessage(error)}`);
		}
	}

	/**
	 * Test the embedding endpoint
	 */
	async testConnection(): Promise<{ success: boolean; error?: string; dimensions?: number }> {
		try {
			LoggingUtility.log('Testing embedding endpoint:', this.config.endpoint);
			const healthCheckInput = `health-check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const testEmbedding = await this.generateEmbedding(healthCheckInput);
			
			return { 
				success: true, 
				dimensions: testEmbedding.length 
			};
		} catch (error) {
			LoggingUtility.error('Embedding connection test failed:', error);
			return { 
				success: false, 
				error: this.getErrorMessage(error) 
			};
		}
	}

	/**
	 * Update configuration
	 */
	updateConfig(config: EmbeddingConfig): void {
		this.config = config;
		this.runtimeMaxInputTokens = undefined;
		this.runtimeLimitsChecked = false;
		this.runtimeLimitCheckPromise = undefined;
		// Mask apiKey in logs
		const safeConfig: EmbeddingConfig = { ...config };
		if (safeConfig.apiKey) safeConfig.apiKey = '[REDACTED]';
		LoggingUtility.log('Updated embedding service config:', {
			endpoint: safeConfig.endpoint,
			model: safeConfig.model,
			apiKey: safeConfig.apiKey,
			maxInputTokens: safeConfig.maxInputTokens ?? this.getMaxInputTokens(),
			maxInputsPerRequest: safeConfig.maxInputsPerRequest ?? this.getMaxInputsPerRequest(),
			maxTokensPerRequest: safeConfig.maxTokensPerRequest ?? this.getMaxTokensPerRequest(),
			chunkOverlapTokens: safeConfig.chunkOverlapTokens ?? this.getChunkOverlap(),
			chunkCombineStrategy: safeConfig.chunkCombineStrategy ?? this.getChunkCombineStrategy()
		});
	}
} 
