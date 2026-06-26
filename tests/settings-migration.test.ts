import { describe, expect, it, vi } from 'vitest';

// Mock main to avoid heavy imports (sql.js wasm) during settings-only tests
vi.mock('../src/main', () => ({
  ContextMode: {
    OPEN_NOTES: 'open-notes',
    SEARCH: 'search',
    NONE: 'none'
  },
  default: class {}
}));

import { SettingsManager, DEFAULT_SETTINGS } from '../src/services/SettingsManager';

describe('SettingsManager migration', () => {
  it('applies defaults for new scaffold settings when absent in stored data', async () => {
    const fakePlugin: any = {
      loadData: vi.fn(async () => ({
        apiEndpoint: 'http://localhost:1234/v1/chat/completions',
        // older data intentionally missing new keys
        maxTokens: 1000
      })),
      saveData: vi.fn(async () => undefined)
    };

    const manager = SettingsManager.initialize(fakePlugin as any);
    await manager.loadSettings();
    const settings = manager.getSettings();

    expect(settings.enableShortResponses).toBe(DEFAULT_SETTINGS.enableShortResponses);
    expect(settings.preferredTone).toBe(DEFAULT_SETTINGS.preferredTone);
  });
});
