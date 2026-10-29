import academicResearchAnalysis from './academic-research-analysis.json';
import contentCreative from './content-creative.json';
import financial from './financial.json';
import healthMedical from './health-medical.json';
import karpathyBlankStart from './karpathy-blank-start.json';
import personalCognitive from './personal-cognitive.json';
import professionalOperational from './professional-operational.json';
import type {
	WorkspaceProfileOption,
	WorkspaceProfileTemplate,
	WorkspaceProfileTemplateId
} from './types';

type WorkspaceProfileTemplateData = Omit<WorkspaceProfileTemplate, 'id'> & { id: string };

function validateWorkspaceProfileTemplate(
	expectedId: WorkspaceProfileTemplateId,
	template: WorkspaceProfileTemplateData
): WorkspaceProfileTemplate {
	if (template.id !== expectedId) {
		throw new Error(`Workspace profile template ID mismatch: expected "${expectedId}", found "${template.id}".`);
	}

	return { ...template, id: expectedId };
}

const workspaceProfileTemplates: Record<WorkspaceProfileTemplateId, WorkspaceProfileTemplate> = {
	'personal-cognitive': validateWorkspaceProfileTemplate('personal-cognitive', personalCognitive),
	'professional-operational': validateWorkspaceProfileTemplate('professional-operational', professionalOperational),
	'academic-research-analysis': validateWorkspaceProfileTemplate('academic-research-analysis', academicResearchAnalysis),
	'karpathy-blank-start': validateWorkspaceProfileTemplate('karpathy-blank-start', karpathyBlankStart),
	'health-medical': validateWorkspaceProfileTemplate('health-medical', healthMedical),
	financial: validateWorkspaceProfileTemplate('financial', financial),
	'content-creative': validateWorkspaceProfileTemplate('content-creative', contentCreative)
};

export const DEFAULT_WORKSPACE_PROFILE_TEMPLATE_ID: WorkspaceProfileTemplateId = 'academic-research-analysis';

const WORKSPACE_PROFILE_TEMPLATE_IDS: WorkspaceProfileTemplateId[] = [
	'personal-cognitive',
	'professional-operational',
	'academic-research-analysis',
	'karpathy-blank-start',
	'health-medical',
	'financial',
	'content-creative'
];

export const WORKSPACE_PROFILE_OPTIONS: WorkspaceProfileOption[] = WORKSPACE_PROFILE_TEMPLATE_IDS.map((templateId) => {
	const template = workspaceProfileTemplates[templateId];
	return {
		id: template.id,
		label: template.label
	};
});

export function getWorkspaceProfileTemplateById(templateId: WorkspaceProfileTemplateId): WorkspaceProfileTemplate {
	return workspaceProfileTemplates[templateId] ?? workspaceProfileTemplates[DEFAULT_WORKSPACE_PROFILE_TEMPLATE_ID];
}

export function getWorkspaceProfileStarterTags(templateId: WorkspaceProfileTemplateId): string[] {
	const template = getWorkspaceProfileTemplateById(templateId);
	const folderNames = new Set(template.folders.flatMap((folder) => folder.split('/')));
	const tags = new Set<string>();

	for (const file of template.templateFiles) {
		const frontmatter = file.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
		const tagLines = frontmatter?.match(/^tags:\r?\n((?:[ \t]+-[ \t]+[^\r\n]*\r?\n?)*)/m)?.[1] ?? '';

		for (const match of tagLines.matchAll(/^[ \t]+-[ \t]+(.+?)\s*$/gm)) {
			const baseTag = match[1].trim().split('/').pop() ?? '';
			const pluralTag = /[^aeiou]y$/.test(baseTag)
				? `${baseTag.slice(0, -1)}ies`
				: /(?:s|x|z|ch|sh)$/.test(baseTag)
					? `${baseTag}es`
					: `${baseTag}s`;
			const tag = folderNames.has(baseTag)
				? baseTag
				: folderNames.has(pluralTag)
					? pluralTag
					: baseTag;
			if (tag) {
				tags.add(tag);
			}
		}
	}

	return [...tags];
}

export function mergeWorkspaceProfileStarterTags(
	existingTags: string[],
	templateId: WorkspaceProfileTemplateId
): string[] {
	const mergedTags = [...existingTags];
	const seenTags = new Set(existingTags.map((tag) => tag.trim().toLowerCase().replace(/\//g, '-')));

	for (const tag of getWorkspaceProfileStarterTags(templateId)) {
		const normalizedTag = tag.trim().toLowerCase().replace(/\//g, '-');
		if (!normalizedTag || seenTags.has(normalizedTag)) {
			continue;
		}

		seenTags.add(normalizedTag);
		mergedTags.push(tag);
	}

	return mergedTags;
}

export type { WorkspaceProfileTemplate, WorkspaceProfileTemplateId } from './types';