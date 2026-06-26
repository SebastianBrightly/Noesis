import { describe, expect, it } from 'vitest';
import {
	appendStudySignalsForIndexing,
	detectSemanticSignal,
	extractFlashcardCandidates,
	parseMarginaliaNotes
} from '../../src/utils/StudyMarkupUtils';

describe('StudyMarkupUtils', () => {
	it('parses Cornell-style marginalia blocks with direction and semantic tags', () => {
		const markdown = [
			'Text one %%> ? What is ATP? ;; %%',
			'Text two %%< V- validated statement %%'
		].join('\n');

		const notes = parseMarginaliaNotes(markdown);
		expect(notes).toHaveLength(2);
		expect(notes[0]).toMatchObject({
			direction: 'right',
			hasActiveRecallMarker: true,
			semanticSignal: 'question',
			text: 'What is ATP?'
		});
		expect(notes[1]).toMatchObject({
			direction: 'left',
			semanticSignal: 'verified',
			text: 'validated statement'
		});
	});

	it('extracts flashcard candidates from ;; cues', () => {
		const markdown = 'Mitochondria produce ATP. %%> ! Main fuel molecule ;; %%';
		const cards = extractFlashcardCandidates(markdown);

		expect(cards).toHaveLength(1);
		expect(cards[0].front).toBe('Main fuel molecule');
		expect(cards[0].back).toContain('Mitochondria produce ATP.');
		expect(cards[0].sourceLine).toBe(1);
	});

	it('builds synthetic study-signal section for retrieval enrichment', () => {
		const markdown = [
			'# Biology',
			'Cell respiration details. %%> ? ATP source? ;; %%',
			'Correction note %%> X- remove old pathway %%'
		].join('\n');

		const enriched = appendStudySignalsForIndexing(markdown);
		expect(enriched).toContain('## Noesis Study Signals');
		expect(enriched).toContain('question: ATP source?');
		expect(enriched).toContain('correction: remove old pathway');
		expect(enriched).toContain('### Active Recall Cues');
	});

	it('detects semantic prefix tags consistently', () => {
		expect(detectSemanticSignal('? why')).toBe('question');
		expect(detectSemanticSignal('! priority')).toBe('important');
		expect(detectSemanticSignal('X- incorrect')).toBe('correction');
		expect(detectSemanticSignal('V- verified')).toBe('verified');
		expect(detectSemanticSignal('plain note')).toBe('neutral');
	});
});
