export type WorkspaceProfileTemplateId =
	| 'personal-cognitive'
	| 'professional-operational'
	| 'academic-research-analysis'
	| 'karpathy-blank-start'
	| 'health-medical'
	| 'financial'
	| 'content-creative';

export interface WorkspaceTemplateFile {
	path: string;
	content: string;
}

export interface WorkspaceProfileTemplate {
	id: WorkspaceProfileTemplateId;
	label: string;
	description: string;
	defaultRootFolder: string;
	folders: string[];
	baseFiles: WorkspaceTemplateFile[];
	templateFiles: WorkspaceTemplateFile[];
}

export interface WorkspaceProfileOption {
	id: WorkspaceProfileTemplateId;
	label: string;
}