import { describe, expect, it, vi } from 'vitest';
import { SearchService } from '../src/services/SearchService';

describe('SearchService keyword fallback', () => {
  it('pre-scores candidates before reading file content', async () => {
    const files = Array.from({ length: 120 }, (_, i) => ({
      path: `notes/file-${i}.md`,
      basename: `file-${i}`,
      extension: 'md',
      stat: { mtime: Date.now() }
    }));

    const targetFile = {
      path: 'research/quantum-breakthrough.md',
      basename: 'quantum-breakthrough',
      extension: 'md',
      stat: { mtime: Date.now() }
    };
    files.push(targetFile);

    const app = {
      vault: {
        getMarkdownFiles: vi.fn(() => files as any[]),
        cachedRead: vi.fn(async (file: any) => {
          if (file.path === targetFile.path) {
            return 'Quantum qubit coherence improved with lower error rates and stable decoding.';
          }
          return 'Unrelated generic note content.';
        })
      },
      metadataCache: {
        getFileCache: vi.fn((file: any) => {
          if (file.path === targetFile.path) {
            return {
              headings: [{ heading: 'Quantum Breakthrough', level: 1 }],
              tags: [{ tag: '#quantum' }]
            };
          }
          return { headings: [], tags: [] };
        })
      },
      workspace: {
        getLeavesOfType: vi.fn(() => []),
        getActiveViewOfType: vi.fn(() => null)
      }
    } as any;

    const service = new SearchService(app);
    const results = await service.searchVault('quantum qubit coherence', {
      maxResults: 5,
      threshold: 0.1
    });

    expect(results.length).toBe(1);
    expect(results[0].path).toBe(targetFile.path);

    // Only prescored candidates should be read, not every markdown file.
    expect(app.vault.cachedRead).toHaveBeenCalledTimes(1);
  });

  it('returns empty results for very short queries', async () => {
    const app = {
      vault: {
        getMarkdownFiles: vi.fn(() => []),
        cachedRead: vi.fn()
      },
      metadataCache: {
        getFileCache: vi.fn(() => null)
      },
      workspace: {
        getLeavesOfType: vi.fn(() => []),
        getActiveViewOfType: vi.fn(() => null)
      }
    } as any;

    const service = new SearchService(app);
    const results = await service.searchVault('hi', {
      maxResults: 5,
      threshold: 0.1
    });

    expect(results).toEqual([]);
    expect(app.vault.cachedRead).not.toHaveBeenCalled();
  });
});

describe('SearchService graph-aware reranking', () => {
  it('boosts semantically-close chunks using link distance, recency, and folder proximity', async () => {
    const now = Date.now();
    const activeFile = {
      path: 'notes/active.md',
      basename: 'active',
      extension: 'md',
      parent: { path: 'notes' },
      stat: { mtime: now }
    };

    const candidateA = {
      path: 'notes/project.md',
      basename: 'project',
      extension: 'md',
      parent: { path: 'notes' },
      stat: { mtime: now - (1 * 24 * 60 * 60 * 1000) }
    };

    const candidateB = {
      path: 'archive/legacy.md',
      basename: 'legacy',
      extension: 'md',
      parent: { path: 'archive' },
      stat: { mtime: now - (180 * 24 * 60 * 60 * 1000) }
    };

    const filesByPath = new Map<string, any>([
      [activeFile.path, activeFile],
      [candidateA.path, candidateA],
      [candidateB.path, candidateB]
    ]);

    const ragService = {
      isIndexEmpty: vi.fn(() => false),
      search: vi.fn(async () => [
        {
          file: candidateB,
          content: 'legacy operations details ^ops-2',
          similarity: 0.75,
          title: 'Legacy',
          path: candidateB.path,
          paragraphIndex: 1,
          anchorType: 'block',
          anchorValue: 'ops-2',
          anchorTarget: '#^ops-2',
          headingPath: 'Archive > Legacy'
        },
        {
          file: candidateA,
          content: 'project roadmap milestones ^road-1',
          similarity: 0.6,
          title: 'Project',
          path: candidateA.path,
          paragraphIndex: 0,
          anchorType: 'block',
          anchorValue: 'road-1',
          anchorTarget: '#^road-1',
          headingPath: 'Work > Project'
        }
      ])
    } as any;

    const app = {
      vault: {
        cachedRead: vi.fn(async (file: any) => `intro\n\n${file.path.includes('project') ? 'project roadmap milestones ^road-1' : 'legacy operations details ^ops-2'}\n\nend`),
        getAbstractFileByPath: vi.fn((path: string) => filesByPath.get(path))
      },
      metadataCache: {
        resolvedLinks: {
          [activeFile.path]: {
            [candidateA.path]: 1
          },
          [candidateA.path]: {},
          [candidateB.path]: {}
        },
        getFileCache: vi.fn(() => null)
      },
      workspace: {
        getActiveViewOfType: vi.fn(() => ({ file: activeFile })),
        getLeavesOfType: vi.fn(() => [])
      },
      internalPlugins: {
        plugins: {
          bookmarks: {
            instance: {
              items: [
                { type: 'file', path: candidateB.path }
              ]
            }
          }
        }
      }
    } as any;

    const service = new SearchService(app, ragService);
    const results = await service.searchVault('project roadmap', {
      maxResults: 2,
      maxTokens: 400,
      threshold: 0.1
    });

    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].path).toBe(candidateA.path);

    const formatted = service.formatSearchResults(results.slice(0, 1), 400);
    expect(formatted).toContain(`Cite: ${candidateA.path}#^road-1`);
    expect(formatted).toContain('Heading: Work > Project');
  });
});
