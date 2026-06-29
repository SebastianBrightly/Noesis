import { describe, expect, it } from 'vitest';
import { normalizeTag, parseAutoMetadataResponse, parseAutoTagResponse } from '../../src/services/AutoTagService';

describe('AutoTagService parsing', () => {
	it('normalizes tag inputs into retrieval-safe tokens', () => {
		expect(normalizeTag('#Machine Learning')).toBe('machine-learning');
		expect(normalizeTag(' project/Deep Work ')).toBe('project/deep-work');
		expect(normalizeTag('***')).toBeNull();
	});

	it('parses strict JSON object with tags field', () => {
		const response = '{"tags":["research/ai","Knowledge-Graph","RAG"]}';
		expect(parseAutoTagResponse(response)).toEqual(['research/ai', 'knowledge-graph', 'rag']);
	});

	it('parses structured rag metadata JSON fields', () => {
		const response = JSON.stringify({
			tags: ['project/research', 'Literature-Review'],
			aliases: ['SOTA review', 'Research map'],
			summary: 'A map of recent literature and methods in this topic area.',
			retrieval_queries: ['latest methods comparison', 'paper findings overview']
		});

		expect(parseAutoMetadataResponse(response)).toEqual({
			tags: ['project/research', 'literature-review'],
			aliases: ['SOTA review', 'Research map'],
			summary: 'A map of recent literature and methods in this topic area.',
			retrievalQueries: ['latest methods comparison', 'paper findings overview']
		});
	});

	it('parses fenced JSON payloads', () => {
		const response = [
			'```json',
			'{"tags":["note-taking","retrieval"]}',
			'```'
		].join('\n');

		expect(parseAutoTagResponse(response)).toEqual(['note-taking', 'retrieval']);
	});

	it('falls back to plain-text list parsing and dedupes', () => {
		const response = [
			'- #Productivity',
			'- productivity',
			'- project/focus'
		].join('\n');

		expect(parseAutoTagResponse(response)).toEqual(['productivity', 'project/focus']);
	});
});
