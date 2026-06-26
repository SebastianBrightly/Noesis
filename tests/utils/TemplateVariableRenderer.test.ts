import { describe, expect, it } from 'vitest';
import {
	DEFAULT_RESPONSE_NOTE_TEMPLATE,
	RESPONSE_TEMPLATE_PRESETS,
	renderTemplateVariables
} from '../../src/utils/TemplateVariableRenderer';

describe('TemplateVariableRenderer', () => {
	it('renders known variables and removes unknown placeholders', () => {
		const output = renderTemplateVariables('Hello {{name}} {{missing}}', {
			name: 'Noesis'
		});

		expect(output).toBe('Hello Noesis ');
	});

	it('renders default response template with required beginner fields', () => {
		const output = renderTemplateVariables(DEFAULT_RESPONSE_NOTE_TEMPLATE, {
			action_title: 'Noesis Explain selection',
			source_link: '[[notes/test#^abc|Jump]]',
			generated_at: '2026-06-26T00:00:00.000Z',
			highlighted_text: '> Selected line',
			response: 'Generated response text',
			source_file: 'notes/test.md',
			source_block_id: 'abc',
			source_excerpt: 'Selected line'
		});

		expect(output).toContain('# Noesis Explain selection');
		expect(output).toContain('Source section: [[notes/test#^abc|Jump]]');
		expect(output).toContain('## Highlighted text');
		expect(output).toContain('## Response');
		expect(output).toContain('Generated response text');
	});

	it('exposes one-click starter presets for beginner formats', () => {
		expect(RESPONSE_TEMPLATE_PRESETS['research-summary']).toBeDefined();
		expect(RESPONSE_TEMPLATE_PRESETS['meeting-notes']).toBeDefined();
		expect(RESPONSE_TEMPLATE_PRESETS['journal-reflection']).toBeDefined();

		expect(RESPONSE_TEMPLATE_PRESETS['research-summary'].template).toContain('## Research Question');
		expect(RESPONSE_TEMPLATE_PRESETS['meeting-notes'].template).toContain('## Action Items');
		expect(RESPONSE_TEMPLATE_PRESETS['journal-reflection'].template).toContain('## What I Notice');
	});
});
