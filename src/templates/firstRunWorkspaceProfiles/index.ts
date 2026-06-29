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

const workspaceProfileTemplates: Record<WorkspaceProfileTemplateId, WorkspaceProfileTemplate> = {
	'personal-cognitive': personalCognitive as WorkspaceProfileTemplate,
	'professional-operational': professionalOperational as WorkspaceProfileTemplate,
	'academic-research-analysis': academicResearchAnalysis as WorkspaceProfileTemplate,
	'karpathy-blank-start': karpathyBlankStart as WorkspaceProfileTemplate,
	'health-medical': healthMedical as WorkspaceProfileTemplate,
	financial: financial as WorkspaceProfileTemplate,
	'content-creative': contentCreative as WorkspaceProfileTemplate
};

export const DEFAULT_WORKSPACE_PROFILE_TEMPLATE_ID: WorkspaceProfileTemplateId = 'academic-research-analysis';

export const WORKSPACE_PROFILE_OPTIONS: WorkspaceProfileOption[] = Object.values(workspaceProfileTemplates).map((template) => ({
	id: template.id,
	label: template.label
}));

export function getWorkspaceProfileTemplateById(templateId: WorkspaceProfileTemplateId): WorkspaceProfileTemplate {
	return workspaceProfileTemplates[templateId] ?? workspaceProfileTemplates[DEFAULT_WORKSPACE_PROFILE_TEMPLATE_ID];
}

export type { WorkspaceProfileTemplate, WorkspaceProfileTemplateId } from './types';