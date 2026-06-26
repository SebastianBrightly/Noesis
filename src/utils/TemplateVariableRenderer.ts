export interface TemplateRenderVariables {
	[key: string]: string;
}

export type ResponseTemplatePresetId = 'research-summary' | 'meeting-notes' | 'journal-reflection';

const VARIABLE_REGEX = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;

export const DEFAULT_RESPONSE_NOTE_TEMPLATE = [
	'# {{action_title}}',
	'',
	'Source section: {{source_link}}',
	'Generated: {{generated_at}}',
	'',
	'## Highlighted text',
	'{{highlighted_text}}',
	'',
	'## Response',
	'{{response}}',
	''
].join('\n');

export const RESPONSE_NOTE_TEMPLATE_HELP = [
	'{{action_title}}',
	'{{source_link}}',
	'{{generated_at}}',
	'{{highlighted_text}}',
	'{{response}}',
	'{{source_file}}',
	'{{source_block_id}}',
	'{{source_excerpt}}'
].join(', ');

export const RESEARCH_SUMMARY_RESPONSE_TEMPLATE = [
	'# Research Summary: {{action_title}}',
	'',
	'Generated: {{generated_at}}',
	'Source: {{source_link}}',
	'',
	'## Research Question',
	'- What is the key question from this note section?',
	'',
	'## Key Points',
	'{{response}}',
	'',
	'## Evidence From Highlight',
	'{{highlighted_text}}',
	'',
	'## Suggested Next Steps',
	'- [ ] Validate with one additional source',
	'- [ ] Add links to related concept notes',
	''
].join('\n');

export const MEETING_NOTES_RESPONSE_TEMPLATE = [
	'# Meeting Notes: {{action_title}}',
	'',
	'Date: {{generated_at}}',
	'Context link: {{source_link}}',
	'',
	'## Discussion Summary',
	'{{response}}',
	'',
	'## Decisions',
	'- ',
	'',
	'## Action Items',
	'- [ ] ',
	'',
	'## Original Excerpt',
	'{{highlighted_text}}',
	''
].join('\n');

export const JOURNAL_REFLECTION_RESPONSE_TEMPLATE = [
	'# Journal Reflection: {{action_title}}',
	'',
	'Generated: {{generated_at}}',
	'Reference: {{source_link}}',
	'',
	'## Reflection',
	'{{response}}',
	'',
	'## What I Notice',
	'- ',
	'',
	'## What I Want To Do Next',
	'- [ ] ',
	'',
	'## Source Passage',
	'{{highlighted_text}}',
	''
].join('\n');

export const RESPONSE_TEMPLATE_PRESETS: Record<ResponseTemplatePresetId, { label: string; template: string }> = {
	'research-summary': {
		label: 'Research Summary',
		template: RESEARCH_SUMMARY_RESPONSE_TEMPLATE
	},
	'meeting-notes': {
		label: 'Meeting Notes',
		template: MEETING_NOTES_RESPONSE_TEMPLATE
	},
	'journal-reflection': {
		label: 'Journal Reflection',
		template: JOURNAL_REFLECTION_RESPONSE_TEMPLATE
	}
};

export function renderTemplateVariables(template: string, variables: TemplateRenderVariables): string {
	if (!template || !template.trim()) {
		return '';
	}

	return template.replace(VARIABLE_REGEX, (_match, variableName: string) => {
		const value = variables[variableName];
		return typeof value === 'string' ? value : '';
	});
}
