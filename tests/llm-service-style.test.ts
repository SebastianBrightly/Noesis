import { describe, expect, it, vi } from 'vitest';
import { LLMService } from '../src/services/LLMService';

declare global {
  var __requestUrlMock: ReturnType<typeof vi.fn>;
}

describe('LLMService style preferences', () => {
  it('includes short-response and tone in system prompt when enabled', async () => {
    global.__requestUrlMock.mockResolvedValue({
      status: 200,
      headers: {},
      text: '',
      json: {
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop'
          }
        ]
      }
    });

    const service = new LLMService({
      apiEndpoint: 'http://localhost:1234/v1/chat/completions',
      systemPrompt: 'Base system',
      enableShortResponses: true
    } as any);

    await service.sendMessage('hello');

    expect(global.__requestUrlMock).toHaveBeenCalled();
    const payload = JSON.parse(global.__requestUrlMock.mock.calls[0][0].body);
    const system = payload.messages.find((m: any) => m.role === 'system');
    expect(system).toBeDefined();
    expect(system.content).toContain('Base system');
    expect(system.content).toContain('Please be concise');
  });
});
