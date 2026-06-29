import { LoggingUtility } from '../utils/LoggingUtility';
import { requestUrl } from 'obsidian';

// Configuration options supplied by the plugin user or settings UI.
// Keeps transport-level configuration (endpoint, API key) and user-facing
// preferences (tone, concise responses) in one place.
// Extended LLMConfig may include stored personality prompts and identity metadata
export interface LLMConfig {
	apiEndpoint: string;
	maxTokens?: number;
	temperature?: number;
	systemPrompt?: string;
	model?: string;
	apiKey?: string;
	// UI-driven preferences
	enableShortResponses?: boolean;
	augmentSystemPromptwithPersonality?: boolean;
	personalityPrompt?: string | string[];
	personalityName?: string| string[];
	storedPersonalitySystemPrompt?: string[];
	IdentityName?: string;

}

// Centralized error message function
// Centralized mapping from thrown errors to friendly, actionable
// messages shown to the user. Keeps error handling consistent across
// all LLM calls and avoids leaking low-level error text directly to UI.
function getLLMErrorMessage(error: Error, endpoint?: string): string {
	if (error.message.includes('API request failed: 400')) {
		return `## ⚠️ Request Rejected by LLM Server (400)

The server is reachable but rejected the request payload.

### Common causes
* Missing required model in request
* max_tokens is above the server/model limit
* Payload format not accepted by the server

### What to check
* Ensure a model is selected in plugin settings
* Lower max tokens in plugin settings
* Verify the endpoint expects OpenAI-compatible chat payloads

Endpoint: ${endpoint ?? 'unknown'}
`;
	}

	// Check if it's a network/connection error
	if (error.message.includes('Failed to fetch') ||
		error.message.includes('NetworkError') ||
		error.message.includes('ERR_NETWORK') ||
		error.message.includes('ERR_CONNECTION_REFUSED') ||
		error.message.includes('ERR_EMPTY_RESPONSE')) {
		return `It appears your local LLM server is not running.
* Check that LM Studio is running and a model is loaded
* Check that you started local server
* Check that Cross-Origin-Resource-Sharing CORS is enabled		
`;
	}

	// Check if it's a timeout error
	if (error.name === 'AbortError' && error.message.includes('timeout')) {
		return 'Request cancelled';
	}

	// Check if it's a server error (5xx)
	if (error.message.includes('500') || error.message.includes('502') ||
		error.message.includes('503') || error.message.includes('504')) {
		return 'Is your LLM server running? 500 error';
	}

	// For other errors, return a generic message
	return `## ⚠️ Connection Error

It appears your local LLM server is not running.

### Troubleshooting Steps
* Check that Local LLM is running and a model is loaded
* **If using LM Studio, click the Local Server tab on the left hand side:**
    * Verify that the server is running
    * Verify that Cross-Origin-Resource-Sharing CORS is enabled
    * Verify that the port number matches that in the settings page of this plugin
	* 
* **If using llama.cpp or another local server:**
	* Verify that the server is running and listening on the correct port
	* Verify that the API endpoint in the plugin settings is correct (e.g. http://localhost:1234/v1/chat/completions)
	* Try accessing the API endpoint directly in your browser or via curl to see if it's responsive
`;
}

// Internal representation of a chat message used by the plugin.
// - `content` supports either a plain string (common for text-only APIs)
//   or an array of typed parts to represent multimodal payloads (text
//   + image URL). The LLMService is responsible for converting this
//   shim to provider-specific request bodies when needed.
export interface ChatMessage {
	role: 'user' | 'assistant' | 'system';
	content: string | Array<{
		type: 'text' | 'image_url';
		text?: string;
		image_url?: {
			url: string;
			detail?: 'low' | 'high' | 'auto';
		};
	}>;
}

// Generic request shape the service sends to a REST endpoint. Note: many
// providers expect different field names — this shape intentionally keeps
// the common subset and lets the service adapt if necessary.
export interface ChatRequest {
	messages: ChatMessage[];
	max_tokens?: number;
	temperature?: number;
	stream?: boolean;
	model?: string;
}

// Expected response shape for non-streaming responses. This mirrors the
// common "choices" pattern used by many APIs (OpenAI-style), but the
// parsing code tolerates variations.
export interface ChatResponse {
	choices: Array<{
		message: {
			content: string;
			role: string;
		};
		finish_reason: string;
	}>;
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

// Structured chunk used when parsing server-sent events (SSE) streaming
// responses. The service normalizes SSE `data: {...}` payloads into this
// shape for downstream consumers.
export interface StreamChunk {
	choices: Array<{
		delta: {
			content?: string;
			role?: string;
		};
		finish_reason?: string;
	}>;
}

// Model listing shapes used when discovering available models from
// various server endpoints (OpenAI-like `data` arrays or LM Studio's
// `models` listing). The parsing code tolerates both formats below.
export interface ModelData {
	id: string;
	object: string;
	created?: number;
	owned_by?: string;
}

export interface ModelsResponse {
	data: ModelData[];
	object: string;
}

// LM Studio specific model listing shape
export interface LMStudioRestModel {
	type?: 'llm' | 'embedding';
	key?: string;
	id?: string;
	display_name?: string;
}

export interface LMStudioRestModelsResponse {
	models: LMStudioRestModel[];
}

export type StreamCallback = (chunk: string, isComplete: boolean) => void;

export class LLMService {
	private config: LLMConfig;

	constructor(config: LLMConfig) {
		this.config = config;
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

	private getCombinedSystemPrompt(): string | undefined {
		const parts: string[] = [];

			if (this.config.augmentSystemPromptwithPersonality) {
			LoggingUtility.log('Augmenting system prompt with personality. Checking for stored personality prompts and names.');
			// If stored personalities are available, prefer the selected identity's prompt
			const personalityName = this.config.personalityName || [];
			const personalityPrompts = this.config.personalityPrompt || [];


			if (personalityPrompts) {
				LoggingUtility.log('Selected personality prompt to augment system prompt:', personalityPrompts);
				parts.push(`Name: ${personalityName}`);
				parts.push(personalityPrompts[0]);
				parts.push("Do not repeat your name or personality unless asked.");
			}
		}



		if (this.config.systemPrompt && this.config.systemPrompt.trim()) {

			parts.push(this.config.systemPrompt.trim());
			LoggingUtility.log('Base system prompt added:', this.config.systemPrompt.trim());
		}
		if (this.config.enableShortResponses) {
			parts.push('Please be concise and prefer short answers when possible.');
			LoggingUtility.log('Short response preference enabled, added to system prompt.');
		}
		
		if (parts.length === 0) return undefined;
		return parts.join('\n');
	}

	private extractUploadedFileUrl(payload: unknown): string | null {
		if (!payload || typeof payload !== 'object') {
			return null;
		}

		const record = payload as Record<string, unknown>;
		if (typeof record.url === 'string' && record.url.length > 0) {
			return record.url;
		}

		if (typeof record.file_url === 'string' && record.file_url.length > 0) {
			return record.file_url;
		}

		if (record.file && typeof record.file === 'object') {
			const fileRecord = record.file as Record<string, unknown>;
			if (typeof fileRecord.url === 'string' && fileRecord.url.length > 0) {
				return fileRecord.url;
			}
		}

		return null;
	}

	async sendMessage(message: string, conversationHistory: ChatMessage[] = []): Promise<string> {
		try {
			const messages: ChatMessage[] = [];

			// Add combined system prompt if configured or if style preferences exist
			const combinedSystem = this.getCombinedSystemPrompt();
			if (combinedSystem && combinedSystem.trim()) {
				messages.push({ role: 'system', content: combinedSystem });
			}

			// Add conversation history and current message
			messages.push(...conversationHistory, { role: 'user', content: message });

			const request: ChatRequest = {
				messages,
				max_tokens: this.config.maxTokens || 1000,
				temperature: this.config.temperature || 0.7,
				stream: false
			};

			// Add model to request if specified
			if (this.config.model) {
				request.model = this.config.model;
			}

			LoggingUtility.log('Sending request to:', this.config.apiEndpoint);
			LoggingUtility.log('Request payload:', JSON.stringify(request, null, 2));

			const response = await this.makeAPIRequest(request);
			return response.choices[0]?.message?.content || 'No response content';
		} catch (error) {
			LoggingUtility.error('Error sending message to LLM:', error);
			throw error;
		}
	}

	/**
	 * Send a vision message with image and text
	 */
	async sendVisionMessage(text: string, imageBase64: string, conversationHistory: ChatMessage[] = []): Promise<string> {
		try {
			const messages: ChatMessage[] = [];

			const combinedSystem = this.getCombinedSystemPrompt();
			if (combinedSystem && combinedSystem.trim()) {
				messages.push({ role: 'system', content: combinedSystem });
			}

			// Add conversation history
			messages.push(...conversationHistory);

			// Try provider-specific upload first (if available)
			let usedImageRef: string | null = null;
			try {
				usedImageRef = await this.uploadImage(imageBase64);
				if (usedImageRef) {
					LoggingUtility.log('Uploaded image and received reference:', usedImageRef);
					// Create vision message referencing uploaded file URL/id
					const visionMessage: ChatMessage = {
						role: 'user',
						content: [
							{ type: 'text', text: text },
							{ type: 'image_url', image_url: { url: usedImageRef, detail: 'high' } }
						]
					};
					messages.push(visionMessage);
				}
			} catch (uploadErr) {
				LoggingUtility.warn('Image upload attempt failed, will fall back to inline base64:', uploadErr);
			}

			// If upload did not provide a usable reference, embed base64 inline in the text
			if (!usedImageRef) {
				const combinedText = `${text}\n\n---BEGIN_IMAGE---\n${imageBase64}\n---END_IMAGE---`;
				messages.push({ role: 'user', content: combinedText });
			}

			const request: ChatRequest = {
				messages,
				max_tokens: this.config.maxTokens || 1000,
				temperature: this.config.temperature || 0.7,
				stream: false
			};

			LoggingUtility.log('Sending vision request to:', this.config.apiEndpoint);
			LoggingUtility.log('Vision request payload:', JSON.stringify(request, null, 2));

			const response = await this.makeAPIRequest(request);
			LoggingUtility.log('Raw vision response:', JSON.stringify(response.choices[0]?.message?.content, null, 2));
			return response.choices[0]?.message?.content || 'No response content';
		} catch (error) {
			LoggingUtility.error('Error sending vision message to LLM:', error);
			throw error;
		}
	}

	/**
	 * Attempt to upload image to provider file endpoints and return a URL or id reference.
	 * Tries a few common endpoints and payload shapes. Returns null if upload isn't supported.
	 */
	async uploadImage(imageBase64: string, filename?: string): Promise<string | null> {
		const endpoints: string[] = [];
		try {
			const parsed = new URL(this.config.apiEndpoint);
			const origin = parsed.origin;
			endpoints.push(`${origin}/api/v1/files`);
			endpoints.push(`${origin}/v1/files`);
			endpoints.push(`${origin}/api/v1/upload`);
			endpoints.push(`${origin}/v1/upload`);
		} catch (e) {
			// fall back to simple replacement
			const fallback = this.config.apiEndpoint.replace('/chat/completions', '').replace('/v1/chat/completions', '');
			endpoints.push(`${fallback}/api/v1/files`);
			endpoints.push(`${fallback}/v1/files`);
		}

		for (const endpoint of endpoints) {
			try {
				LoggingUtility.log('Attempting image upload to:', endpoint);
				// Prefer multipart/form-data upload via fetch (common for LM Studio-style file endpoints)
				if (typeof fetch !== 'undefined' && typeof FormData !== 'undefined') {
					try {
						// Parse data URI if present
						let base64 = imageBase64;
						let mime = 'application/octet-stream';
						if (imageBase64.startsWith('data:')) {
							const parts = imageBase64.split(',', 2);
							const meta = parts[0];
							base64 = parts[1];
							const m = meta.match(/data:([^;]+);base64/);
							if (m) mime = m[1];
						}

						// Decode base64 to binary
						const binStr = atob(base64);
						const len = binStr.length;
						const bytes = new Uint8Array(len);
						for (let i = 0; i < len; i++) bytes[i] = binStr.charCodeAt(i);

						const blob = new Blob([bytes.buffer], { type: mime });
						const form = new FormData();
						form.append('file', blob, filename || `image-${Date.now()}.png`);

						// Build headers but remove Content-Type so browser sets multipart boundary
						const headers = this.buildHeaders();
						if (headers['Content-Type']) delete headers['Content-Type'];

						const resp = await fetch(endpoint, {
							method: 'POST',
							headers,
							body: form
						});

						if (!resp.ok) {
							LoggingUtility.warn('Upload endpoint returned error status:', resp.status);
							continue;
						}

						const body: unknown = await resp.json();
						const uploadedUrl = this.extractUploadedFileUrl(body);
						if (uploadedUrl) {
							return uploadedUrl;
						}
					} catch (fetchErr) {
						LoggingUtility.warn('Multipart upload via fetch failed, will try JSON fallback:', fetchErr);
						// fall through to JSON fallback below
					}
				}

				// Fallback: send JSON body with base64 content (older/simple endpoints)
				const headersJson = this.buildHeaders();
				const response = await requestUrl({
					url: endpoint,
					method: 'POST',
					headers: headersJson,
					body: JSON.stringify({ filename: filename || `image-${Date.now()}.png`, content: imageBase64 })
				});

				if (response.status >= 400) {
					LoggingUtility.warn('Upload endpoint returned error status:', response.status);
					continue;
				}

				const body: unknown = response.json;
				const uploadedUrl = this.extractUploadedFileUrl(body);
				if (uploadedUrl) {
					return uploadedUrl;
				}
			} catch (err) {
				LoggingUtility.warn('Image upload attempt failed for endpoint:', endpoint, err);
				continue;
			}
		}

		return null;
	}

	async sendMessageStream(message: string, conversationHistory: ChatMessage[] = [], callback: StreamCallback, abortSignal?: AbortSignal): Promise<void> {
		try {
			const messages: ChatMessage[] = [];

			const combinedSystem = this.getCombinedSystemPrompt();
			if (combinedSystem && combinedSystem.trim()) {
				messages.push({ role: 'system', content: combinedSystem });
			}

			// Add conversation history and current message
			messages.push(...conversationHistory, { role: 'user', content: message });

			const request: ChatRequest = {
				messages,
				max_tokens: this.config.maxTokens || 1000,
				temperature: this.config.temperature || 0.7,
				stream: true
			};

			// Add model to request if specified
			if (this.config.model) {
				request.model = this.config.model;
			}

			LoggingUtility.log('Sending streaming request to:', this.config.apiEndpoint);
			LoggingUtility.log('Request payload:', JSON.stringify(request, null, 2));

			await this.makeStreamingAPIRequest(request, callback, abortSignal);
		} catch (error) {
			if (error.name === 'AbortError') {
				LoggingUtility.log('Request was cancelled by user');
				return;
			}
			LoggingUtility.error('Error sending streaming message to LLM:', error);
			throw error;
		}
	}

	private async makeAPIRequest(request: ChatRequest): Promise<ChatResponse> {
		const headers = this.buildHeaders();

		LoggingUtility.log('Making API request to:', this.config.apiEndpoint);
		LoggingUtility.log('Headers:', headers);

		try {
			const response = await requestUrl({
				url: this.config.apiEndpoint,
				method: 'POST',
				headers,
				body: JSON.stringify(request)
			});

			LoggingUtility.log('Response status:', response.status);
			LoggingUtility.log('Response headers:', response.headers);

			if (response.status >= 400) {
				const errorText = response.text;
				LoggingUtility.error('API Error Response:', errorText);
				throw new Error(`API request failed: ${response.status} - ${errorText}`);
			}

			const responseData: unknown = response.json;
			LoggingUtility.log('Response data:', responseData);
			return responseData as ChatResponse;
		} catch (error) {
			LoggingUtility.error('Fetch error details:', error);
			throw new Error(getLLMErrorMessage(error, this.config.apiEndpoint));
		}
	}

	private async makeStreamingAPIRequest(request: ChatRequest, callback: StreamCallback, abortSignal?: AbortSignal): Promise<void> {
		LoggingUtility.log('Making streaming API request to:', this.config.apiEndpoint);

		// Note: requestUrl doesn't support streaming, so we fall back to fetch for streaming requests
		// This is a known limitation when working with streaming APIs in Obsidian plugins
		try {
			// For streaming, we need to use native fetch as Obsidian's requestUrl doesn't support streaming
			if (!window || !window.fetch) {
				throw new Error('Streaming is not supported in this environment');
			}

			const headers = this.buildHeaders();

			const response = await fetch(this.config.apiEndpoint, {
				method: 'POST',
				headers,
				body: JSON.stringify(request),
				signal: abortSignal || AbortSignal.timeout(60000), // 60 second timeout for streaming
			});

			LoggingUtility.log('Streaming response status:', response.status);

			if (!response.ok) {
				const errorText = await response.text();
				LoggingUtility.error('Streaming API Error Response:', errorText);
				throw new Error(`Streaming API request failed: ${response.status} ${response.statusText} - ${errorText}`);
			}

			if (!response.body) {
				throw new Error('No response body for streaming request');
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let isCompleted = false; // Flag to prevent multiple completion signals

			try {
				while (true) {
					const { done, value } = await reader.read();

					if (done) {
						// Process any remaining buffer
						if (buffer.trim() && !isCompleted) {
							this.processStreamChunk(buffer, callback);
						}
						if (!isCompleted) {
							callback('', true); // Signal completion
							isCompleted = true;
						}
						break;
					}

					// Decode the chunk and add to buffer
					buffer += decoder.decode(value, { stream: true });

					// Process complete lines
					const lines = buffer.split('\n');
					buffer = lines.pop() || ''; // Keep incomplete line in buffer

					for (const line of lines) {
						if (line.trim() && line.startsWith('data: ')) {
							const data = line.slice(6); // Remove 'data: ' prefix

							if (data === '[DONE]') {
								if (!isCompleted) {
									callback('', true); // Signal completion
									isCompleted = true;
								}
								return;
							}

							try {
								const chunk: StreamChunk = JSON.parse(data);
								this.processStreamChunk(chunk, callback, isCompleted);
								// Check if completion was signaled by processStreamChunk
								if (chunk.choices?.some(choice => choice.finish_reason)) {
									isCompleted = true;
								}
							} catch (parseError) {
								LoggingUtility.warn('Failed to parse streaming chunk:', data, parseError);
							}
						}
					}
				}
			} finally {
				reader.releaseLock();
			}
		} catch (error) {
			LoggingUtility.error('Streaming fetch error details:', error);

			// Handle specific error types
			if (error.name === 'AbortError') {
				// Re-throw as AbortError so the caller can detect user cancellation
				throw error;
			}

			throw new Error(getLLMErrorMessage(error, this.config.apiEndpoint));
		}
	}

	private processStreamChunk(chunk: StreamChunk | string, callback: StreamCallback, isCompleted: boolean = false): void {
		if (typeof chunk === 'string') {
			// Handle raw string chunks (fallback)
			if (chunk.trim() && !isCompleted) {
				callback(chunk, false);
			}
			return;
		}

		// Handle structured chunks
		for (const choice of chunk.choices) {
			if (choice.delta?.content && !isCompleted) {
				callback(choice.delta.content, false);
			}

			if (choice.finish_reason && !isCompleted) {
				callback('', true); // Signal completion
				return;
			}
		}
	}

	// Helper method to test connection
	async testConnection(): Promise<{ success: boolean; error?: string }> {
		try {
			LoggingUtility.log('Testing connection to:', this.config.apiEndpoint);

			// Create a simple test request asking for a smiley face
			const testRequest: ChatRequest = {
				messages: [{ role: 'user', content: 'Return a smiley face' }],
				max_tokens: 10,
				temperature: 0.1,
				stream: false
			};

			// Add model to test request if specified
			if (this.config.model) {
				testRequest.model = this.config.model;
			}

			const response = await this.makeAPIRequest(testRequest);

			// Log the actual response structure for debugging
			LoggingUtility.log('Connection test - full response structure:', JSON.stringify(response, null, 2));

			// Verify we got a response with content
			if (!response.choices || response.choices.length === 0) {
				throw new Error(`Invalid response structure from API - no choices array. Response: ${JSON.stringify(response)}`);
			}

			const firstChoice = response.choices[0];
			if (!firstChoice.message) {
				throw new Error(`Invalid response structure from API - no message in choice. Choice: ${JSON.stringify(firstChoice)}`);
			}

			// Some APIs might return empty content, which is still a valid connection
			const content = firstChoice.message.content;
			if (content === null || content === undefined) {
				LoggingUtility.warn('API returned null/undefined content, but connection appears successful');
			}

			LoggingUtility.log('Connection test successful, received response:', content);
			return { success: true };
		} catch (error) {
			LoggingUtility.error('Connection test failed:', error);
			return {
				success: false,
				error: getLLMErrorMessage(error, this.config.apiEndpoint)
			};
		}
	}

	// Method to get supported models (if the API supports it)
	async getAvailableModels(): Promise<string[]> {
		try {
			const models = await this.fetchAvailableModels();
			return models.map((model) => model.id);
		} catch (error) {
			LoggingUtility.error('Failed to fetch available models:', error);
			return [];
		}
	}

	async getAvailableEmbeddingModels(): Promise<string[]> {
		try {
			const models = await this.fetchAvailableModels();

			return models
				.filter(model => {
					if (model.type === 'embedding') {
						return true;
					}

					const id = model.id.toLowerCase();
					return id.includes('embedding') || id.includes('embed');
				})
				.map(model => model.id);
		} catch (error) {
			LoggingUtility.error('Failed to fetch available embedding models:', error);
			return [];
		}
	}

	private async fetchAvailableModels(): Promise<Array<{ id: string; type?: 'llm' | 'embedding' }>> {
		const endpoints = this.getModelListEndpoints();
		const headers = this.buildHeaders();

		for (const endpoint of endpoints) {
			try {
				LoggingUtility.log('Fetching models from:', endpoint);
				const response = await requestUrl({
					url: endpoint,
					method: 'GET',
					headers
				});

				if (response.status >= 400) {
					throw new Error(`Failed to fetch models: ${response.status}`);
				}

				const parsed = this.parseModelsResponse(response.json);
				if (parsed.length > 0) {
					return parsed;
				}
			} catch (error) {
				LoggingUtility.warn(`Failed to fetch models from ${endpoint}:`, error);
			}
		}

		throw new Error('Failed to fetch models from all known model endpoints');
	}

	private getModelListEndpoints(): string[] {
		try {
			const parsedUrl = new URL(this.config.apiEndpoint);
			const pathLower = parsedUrl.pathname.toLowerCase();

			const basePath =
				pathLower.includes('/v1/')
					? parsedUrl.pathname.substring(0, pathLower.indexOf('/v1/'))
					: '';

			return [
				`${parsedUrl.origin}${basePath}/api/v1/models`,
				`${parsedUrl.origin}${basePath}/v1/models`
			];
			} catch (error) {
				LoggingUtility.error('Error parsing URL for model endpoint:', error);
			const fallbackBase = this.config.apiEndpoint
				.replace('/chat/completions', '')
				.replace('/embeddings', '')
				.replace('/v1/models', '')
				.replace('/api/v1/models', '');

			return [
				`${fallbackBase}/api/v1/models`,
				`${fallbackBase}/v1/models`
			];
		}
	}

	private parseModelsResponse(payload: unknown): Array<{ id: string; type?: 'llm' | 'embedding' }> {
		const modelMap = new Map<string, { id: string; type?: 'llm' | 'embedding' }>();
		const dataPayload = payload as Partial<ModelsResponse>;
		const lmStudioPayload = payload as Partial<LMStudioRestModelsResponse>;

		if (Array.isArray(dataPayload.data)) {
			dataPayload.data
				.map(model => model?.id)
				.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
				.forEach(id => {
					modelMap.set(id, { id });
				});
		}

		if (Array.isArray(lmStudioPayload.models)) {
			lmStudioPayload.models
				.map(model => ({
					id: model?.key || model?.id || model?.display_name || '',
					type: model?.type
				}))
				.forEach(model => {
					if (typeof model.id === 'string' && model.id.trim().length > 0) {
						modelMap.set(model.id, model);
					}
				});
		}

		return Array.from(modelMap.values());
	}

	// Method to validate configuration
	validateConfig(): { valid: boolean; errors: string[] } {
		const errors: string[] = [];

		if (!this.config.apiEndpoint) {
			errors.push('API endpoint is required');
		}

		// Validate URL format
		try {
			new URL(this.config.apiEndpoint);
			} catch (error) {
				LoggingUtility.error('Invalid API endpoint URL format:', error);
			errors.push('Invalid API endpoint URL format');
		}

		return {
			valid: errors.length === 0,
			errors
		};
	}
}

// Factory function to create LLM service
export function createLLMService(config: Partial<LLMConfig>): LLMService {
	const defaultConfig: LLMConfig = {
		apiEndpoint: 'http://localhost:1234/v1/chat/completions',
		...config,
	};

	return new LLMService(defaultConfig);
} 
