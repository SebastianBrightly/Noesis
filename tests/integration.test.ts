import { beforeEach, describe, expect, it, vi } from 'vitest';

const llmMock = {
  testConnection: vi.fn(),
  sendMessageStream: vi.fn()
};

vi.mock('../src/main', () => ({
  ContextMode: {
    OPEN_NOTES: 'open-notes',
    SEARCH: 'search',
    NONE: 'none'
  },
  default: class {}
}));

vi.mock('../src/services/LLMService', () => ({
  createLLMService: vi.fn(() => llmMock)
}));

import { ChatView } from '../src/views/ChatView';
import { WorkspaceLeaf, MarkdownView } from 'obsidian';

// --- Test data ---

const QUANTUM_ARTICLE = {
  path: 'research/quantum-computing.md',
  basename: 'quantum-computing',
  extension: 'md',
  content: [
    '# Quantum Computing Advances',
    '',
    'Researchers at MIT demonstrated a 1000-qubit quantum processor capable of error correction.',
    'The breakthrough uses topological qubits that are inherently more stable than previous designs.',
    '',
    '## Key Findings',
    '- Error rates reduced by 99.7%',
    '- Coherence time extended to 10 milliseconds',
    '- First demonstration of fault-tolerant quantum computation',
  ].join('\n'),
};

const RECIPE_ARTICLE = {
  path: 'personal/sourdough-recipe.md',
  basename: 'sourdough-recipe',
  extension: 'md',
  content: [
    '# Sourdough Bread Recipe',
    '',
    'A simple sourdough recipe using a 72-hour cold ferment.',
    '',
    '## Ingredients',
    '- 500g bread flour',
    '- 350g water',
    '- 100g active starter',
    '- 10g salt',
  ].join('\n'),
};

const HAYSTACK_FILES = [
  {
    path: 'notes/meeting-notes.md',
    basename: 'meeting-notes',
    extension: 'md',
    content: '# Weekly Team Meeting\n\nDiscussed project timelines and resource allocation.\n\n## Action Items\n- Review Q3 budget\n- Update sprint backlog',
  },
  {
    path: 'notes/travel-plans.md',
    basename: 'travel-plans',
    extension: 'md',
    content: '# Summer Travel Plans\n\nLooking at flights to Barcelona for August.\n\n## Budget\n- Flights: $800\n- Hotel: $1200\n- Food: $500',
  },
  {
    path: 'research/superconductor-breakthrough.md',
    basename: 'superconductor-breakthrough',
    extension: 'md',
    content: '# Room Temperature Superconductor\n\nThe compound LK-99 containing lanarkite achieved superconductivity at 127 degrees Celsius and ambient pressure. This xylophone-paradox-7 discovery could revolutionize energy transmission.\n\n## Verification\n- Meissner effect confirmed\n- Resistance drops to zero at 127C\n- Crystal structure analyzed via X-ray diffraction',
  },
  {
    path: 'personal/grocery-list.md',
    basename: 'grocery-list',
    extension: 'md',
    content: '# Grocery List\n\n- Milk\n- Eggs\n- Bread\n- Apples\n- Chicken breast',
  },
];

// --- Helpers ---

function createPluginStub(contextMode: string) {
  return {
    settings: {
      apiEndpoint: 'http://localhost:1234/v1/chat/completions',
      apiKey: '',
      maxTokens: 2048,
      temperature: 0.7,
      systemPrompt: 'Be concise',
      model: undefined,
      contextMode,
      ragMaxResults: 5,
      ragThreshold: 0.1,
      searchContextPercentage: 50,
      contextNotesVisible: false,
    },
    ragService: {
      isCurrentlyIndexing: false,
      isIndexEmpty: () => true,
      getStats: () => ({ documentCount: 0, fileCount: 0 }),
    },
    saveSettings: vi.fn(async () => undefined),
  };
}

function createAppStubForOpenNotes() {
  const quantumFile = { ...QUANTUM_ARTICLE };
  const recipeFile = { ...RECIPE_ARTICLE };

  const quantumLeaf = {
    view: Object.assign(new MarkdownView(quantumFile), { file: quantumFile }),
  };
  const recipeLeaf = {
    view: Object.assign(new MarkdownView(recipeFile), { file: recipeFile }),
  };

  return {
    workspace: {
      openLinkText: vi.fn(),
      getLeavesOfType: vi.fn((type: string) => {
        if (type === 'markdown') return [quantumLeaf, recipeLeaf];
        return [];
      }),
      getActiveViewOfType: vi.fn(() => null),
    },
    vault: {
      cachedRead: vi.fn(async (file: any) => {
        if (file.path === QUANTUM_ARTICLE.path) return QUANTUM_ARTICLE.content;
        if (file.path === RECIPE_ARTICLE.path) return RECIPE_ARTICLE.content;
        return '';
      }),
      getMarkdownFiles: vi.fn(() => []),
    },
    metadataCache: {
      getFileCache: vi.fn((file: any) => {
        if (file.path === QUANTUM_ARTICLE.path) {
          return {
            headings: [{ heading: 'Quantum Computing Advances', level: 1 }],
            tags: [{ tag: '#physics' }, { tag: '#quantum' }],
          };
        }
        if (file.path === RECIPE_ARTICLE.path) {
          return {
            headings: [{ heading: 'Sourdough Bread Recipe', level: 1 }],
            tags: [{ tag: '#cooking' }, { tag: '#bread' }],
          };
        }
        return null;
      }),
    },
    setting: { open: vi.fn(), openTabById: vi.fn() },
  };
}

function createAppStubForSearch() {
  const files = HAYSTACK_FILES.map((f) => ({ ...f }));

  return {
    workspace: {
      openLinkText: vi.fn(),
      getLeavesOfType: vi.fn(() => []),
      getActiveViewOfType: vi.fn(() => null),
    },
    vault: {
      cachedRead: vi.fn(async (file: any) => {
        const found = HAYSTACK_FILES.find((f) => f.path === file.path);
        return found ? found.content : '';
      }),
      getMarkdownFiles: vi.fn(() => files),
    },
    metadataCache: {
      getFileCache: vi.fn((file: any) => {
        if (file.path === 'research/superconductor-breakthrough.md') {
          return {
            headings: [{ heading: 'Room Temperature Superconductor', level: 1 }],
            tags: [{ tag: '#physics' }, { tag: '#superconductor' }],
          };
        }
        return { headings: [], tags: [] };
      }),
    },
    setting: { open: vi.fn(), openTabById: vi.fn() },
  };
}

async function flushRenderTicks(n = 2): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// --- Tests ---

describe('Integration: end-to-end context pipeline', () => {
  beforeEach(() => {
    llmMock.testConnection.mockReset();
    llmMock.sendMessageStream.mockReset();
  });

  it('OPEN_NOTES mode: open note content reaches the LLM and response renders', async () => {
    llmMock.testConnection.mockResolvedValue({ success: true });

    let capturedEnhancedMessage = '';
    llmMock.sendMessageStream.mockImplementation(
      async (message: string, _history: any[], callback: (chunk: string, done: boolean) => Promise<void>) => {
        capturedEnhancedMessage = message;
        await callback('The quantum article covers a 1000-qubit processor, and the recipe describes a 72-hour cold ferment.', false);
        await callback('', true);
      },
    );

    const app = createAppStubForOpenNotes();
    const leaf = new WorkspaceLeaf(app);
    const view = new ChatView(leaf as any, createPluginStub('open-notes') as any);
    await view.onOpen();

    const input = view.containerEl.querySelector('textarea') as HTMLTextAreaElement;
    const sendButton = view.containerEl.querySelector('.local-llm-send-button') as HTMLButtonElement;

    input.value = 'summarize the current articles';
    sendButton.click();
    await flushRenderTicks(8);

    // The enhanced message wraps vault context around the user question
    expect(capturedEnhancedMessage).toContain('Context from your Obsidian vault:');
    expect(capturedEnhancedMessage).toContain('User question: summarize the current articles');
    expect(capturedEnhancedMessage).toContain('--- RELEVANT OBSIDIAN NOTES ---');

    // Both notes' content is included
    expect(capturedEnhancedMessage).toContain('1000-qubit quantum processor');
    expect(capturedEnhancedMessage).toContain('topological qubits');
    expect(capturedEnhancedMessage).toContain('72-hour cold ferment');
    expect(capturedEnhancedMessage).toContain('500g bread flour');

    // Titles and full relevance for open notes
    expect(capturedEnhancedMessage).toContain('Quantum Computing Advances');
    expect(capturedEnhancedMessage).toContain('Sourdough Bread Recipe');
    expect(capturedEnhancedMessage).toContain('Relevance: 100.0%');

    // LLM response renders in the DOM
    const rendered = view.containerEl.textContent ?? '';
    expect(rendered).toContain('1000-qubit processor');
    expect(rendered).toContain('72-hour cold ferment');

    expect(llmMock.sendMessageStream).toHaveBeenCalledTimes(1);
  });

  it('SEARCH mode: keyword search finds needle file and excludes irrelevant notes', async () => {
    llmMock.testConnection.mockResolvedValue({ success: true });

    let capturedEnhancedMessage = '';
    llmMock.sendMessageStream.mockImplementation(
      async (message: string, _history: any[], callback: (chunk: string, done: boolean) => Promise<void>) => {
        capturedEnhancedMessage = message;
        await callback('The xylophone-paradox-7 discovery appears in the superconductor note about LK-99.', false);
        await callback('', true);
      },
    );

    const app = createAppStubForSearch();
    const leaf = new WorkspaceLeaf(app);
    const view = new ChatView(leaf as any, createPluginStub('search') as any);
    await view.onOpen();

    const input = view.containerEl.querySelector('textarea') as HTMLTextAreaElement;
    const sendButton = view.containerEl.querySelector('.local-llm-send-button') as HTMLButtonElement;

    input.value = 'xylophone-paradox-7 superconductor';
    sendButton.click();
    await flushRenderTicks(8);

    // The enhanced message contains vault context
    expect(capturedEnhancedMessage).toContain('Context from your Obsidian vault:');
    expect(capturedEnhancedMessage).toContain('User question: xylophone-paradox-7 superconductor');

    // The needle file IS in the context
    expect(capturedEnhancedMessage).toContain('xylophone-paradox-7');
    expect(capturedEnhancedMessage).toContain('Room Temperature Superconductor');
    expect(capturedEnhancedMessage).toContain('superconductor-breakthrough.md');

    // Irrelevant files are NOT in the context
    expect(capturedEnhancedMessage).not.toContain('grocery-list');
    expect(capturedEnhancedMessage).not.toContain('Milk');
    expect(capturedEnhancedMessage).not.toContain('Chicken breast');

    // LLM response renders in the DOM
    const rendered = view.containerEl.textContent ?? '';
    expect(rendered).toContain('xylophone-paradox-7 discovery');
    expect(rendered).toContain('LK-99');

    expect(llmMock.sendMessageStream).toHaveBeenCalledTimes(1);
  });
});
