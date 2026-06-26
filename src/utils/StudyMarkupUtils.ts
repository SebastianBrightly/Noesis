export type MarginaliaDirection = 'left' | 'right';

export type SemanticSignal =
	| 'question'
	| 'important'
	| 'correction'
	| 'verified'
	| 'neutral';

export interface MarginaliaNote {
	raw: string;
	text: string;
	direction: MarginaliaDirection;
	hasActiveRecallMarker: boolean;
	semanticSignal: SemanticSignal;
}

export interface FlashcardCandidate {
	front: string;
	back: string;
	sourceLine: number;
}

const MARGINALIA_REGEX = /%%([<>])([\s\S]*?)%%/g;

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function removeActiveRecallMarker(value: string): string {
	return normalizeWhitespace(value.replace(/;;+/g, ' '));
}

function stripSemanticPrefix(value: string): string {
	return normalizeWhitespace(value.replace(/^(\?|!|x-|v-)\s*/i, ''));
}

export function detectSemanticSignal(value: string): SemanticSignal {
	const trimmed = value.trim();
	if (/^\?/i.test(trimmed)) {
		return 'question';
	}
	if (/^!/i.test(trimmed)) {
		return 'important';
	}
	if (/^x-/i.test(trimmed)) {
		return 'correction';
	}
	if (/^v-/i.test(trimmed)) {
		return 'verified';
	}
	return 'neutral';
}

export function parseMarginaliaNotes(markdown: string): MarginaliaNote[] {
	const notes: MarginaliaNote[] = [];
	let match: RegExpExecArray | null;

	while ((match = MARGINALIA_REGEX.exec(markdown)) !== null) {
		const direction: MarginaliaDirection = match[1] === '<' ? 'left' : 'right';
		const raw = normalizeWhitespace(match[2]);
		if (!raw) {
			continue;
		}

		notes.push({
			raw,
			text: stripSemanticPrefix(removeActiveRecallMarker(raw)),
			direction,
			hasActiveRecallMarker: /;;/.test(raw),
			semanticSignal: detectSemanticSignal(raw)
		});
	}

	return notes;
}

export function extractFlashcardCandidates(markdown: string): FlashcardCandidate[] {
	const lines = markdown.split(/\r?\n/);
	const cards: FlashcardCandidate[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.includes(';;')) {
			continue;
		}

		const lineNotes = parseMarginaliaNotes(line).filter(note => note.hasActiveRecallMarker);
		if (lineNotes.length === 0) {
			continue;
		}

		const sourceText = normalizeWhitespace(line.replace(MARGINALIA_REGEX, ' ').replace(/\s+/g, ' '));

		for (const note of lineNotes) {
			const front = note.text;
			if (!front) {
				continue;
			}

			cards.push({
				front,
				back: sourceText || 'Review source context in note.',
				sourceLine: i + 1
			});
		}
	}

	return cards;
}

export function appendStudySignalsForIndexing(markdown: string): string {
	const notes = parseMarginaliaNotes(markdown);
	const cards = extractFlashcardCandidates(markdown);

	if (notes.length === 0 && cards.length === 0) {
		return markdown;
	}

	const bySignal: Record<SemanticSignal, string[]> = {
		question: [],
		important: [],
		correction: [],
		verified: [],
		neutral: []
	};

	for (const note of notes) {
		if (note.text) {
			bySignal[note.semanticSignal].push(note.text);
		}
	}

	const lines: string[] = [];
	lines.push('', '## Noesis Study Signals');
	for (const signal of Object.keys(bySignal) as SemanticSignal[]) {
		const values = bySignal[signal];
		if (values.length === 0) {
			continue;
		}
		lines.push(`- ${signal}: ${values.slice(0, 20).join(' | ')}`);
	}

	if (cards.length > 0) {
		lines.push('### Active Recall Cues');
		for (const card of cards.slice(0, 20)) {
			lines.push(`- Q: ${card.front} | A: ${card.back}`);
		}
	}

	return `${markdown}\n${lines.join('\n')}\n`;
}
