import { describe, it, expect } from 'vitest';
import { ImageTextExtractor } from '../src/services/ImageTextExtractor';

class MockLLMService {
	async getAvailableModels() { return []; }
	async sendVisionMessage(text: string, imageBase64: string) {
		// Simulate successful extraction
		return 'Hello from image';
	}
}

class MockVault {
	async readBinary(file: any) {
		// return ArrayBuffer for a 1x1 PNG
		const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=';
		const buf = Buffer.from(base64, 'base64');
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	}
}

const mockApp: any = { vault: new MockVault() };

describe('ImageTextExtractor', () => {
	it('extracts text via LLM service', async () => {
		const llm = new MockLLMService() as any;
		const extractor = new ImageTextExtractor(llm, mockApp);
		// minimal TFile stub
		const file = { name: 'tiny.png', extension: 'png' } as any;
		const result = await extractor.extractTextFromImage(file);
		expect(result.success).toBe(true);
		expect(result.extractedText).toBe('Hello from image');
	});
});
