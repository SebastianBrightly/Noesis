import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import LocalLLMPlugin from '@/main';

interface FirstRunScaffoldOptions {
	rootFolder: string;
	createTemplates: boolean;
	openOverviewAfterCreate: boolean;
}

interface ScaffoldSummary {
	createdFiles: number;
	createdFolders: number;
	rootFolder: string;
}

export class FirstRunWizardModal extends Modal {
	private plugin: LocalLLMPlugin;
	private rootFolder: string;
	private createTemplates: boolean = true;
	private openOverviewAfterCreate: boolean = true;

	constructor(app: App, plugin: LocalLLMPlugin) {
		super(app);
		this.plugin = plugin;
		this.rootFolder = plugin.settings.researchWorkspaceRoot || 'my-research';
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('noesis-first-run-wizard');

		contentEl.createEl('h2', { text: 'Noesis Research Wizard' });
		contentEl.createEl('p', {
			text: 'Create a research workspace in your vault with RAG-ready folders and starter templates.'
		});

		const structurePreview = [
			'my-research/',
			'  raw/ (articles, papers, repos, data, images, assets)',
			'  wiki/ (index, log, overview, concepts, entities, sources, comparisons)',
			'  outputs/',
			'  CLAUDE.md',
			'  .gitignore'
		].join('\n');
		contentEl.createEl('pre', {
			cls: 'noesis-first-run-structure-preview',
			text: structurePreview
		});

		new Setting(contentEl)
			.setName('Research root folder')
			.setDesc('Vault-relative path. Example: my-research')
			.addText((text) => {
				text.setPlaceholder('my-research')
					.setValue(this.rootFolder)
					.onChange((value) => {
						this.rootFolder = value;
					});
			});

		new Setting(contentEl)
			.setName('Create RAG templates')
			.setDesc('Adds source, concept, entity, and comparison templates.')
			.addToggle((toggle) => {
				toggle.setValue(this.createTemplates).onChange((value) => {
					this.createTemplates = value;
				});
			});

		new Setting(contentEl)
			.setName('Open overview after setup')
			.setDesc('Open the generated overview note when setup finishes.')
			.addToggle((toggle) => {
				toggle.setValue(this.openOverviewAfterCreate).onChange((value) => {
					this.openOverviewAfterCreate = value;
				});
			});

		const actions = contentEl.createDiv({ cls: 'noesis-first-run-actions' });
		const skipButton = actions.createEl('button', { text: 'Skip for now' });
		skipButton.addEventListener('click', async () => {
			this.plugin.settings.hasCompletedFirstRunWizard = true;
			await this.plugin.saveSettings();
			new Notice('First-run wizard skipped. Use command palette to reopen it anytime.');
			this.close();
		});

		const createButton = actions.createEl('button', {
			text: 'Create Workspace',
			cls: 'mod-cta'
		});
		createButton.addEventListener('click', async () => {
			createButton.disabled = true;
			skipButton.disabled = true;
			try {
				const summary = await this.createResearchWorkspace({
					rootFolder: this.rootFolder,
					createTemplates: this.createTemplates,
					openOverviewAfterCreate: this.openOverviewAfterCreate
				});
				new Notice(`Workspace created: ${summary.rootFolder} (${summary.createdFolders} folders, ${summary.createdFiles} files)`);
				this.close();
			} catch (error) {
				new Notice(`Failed to create workspace: ${error instanceof Error ? error.message : String(error)}`);
				createButton.disabled = false;
				skipButton.disabled = false;
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private sanitizeVaultPath(pathValue: string): string {
		const normalized = pathValue.replace(/\\/g, '/').trim().replace(/^\/+/, '').replace(/\/+$/, '');
		if (!normalized) {
			return 'my-research';
		}
		return normalized;
	}

	private async ensureFolder(folderPath: string): Promise<boolean> {
		const normalized = this.sanitizeVaultPath(folderPath);
		if (await this.app.vault.adapter.exists(normalized)) {
			return false;
		}

		const segments = normalized.split('/').filter(segment => segment.length > 0);
		let current = '';
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			if (!(await this.app.vault.adapter.exists(current))) {
				await this.app.vault.adapter.mkdir(current);
			}
		}

		return true;
	}

	private async createFileIfMissing(pathValue: string, content: string): Promise<boolean> {
		const normalized = this.sanitizeVaultPath(pathValue);
		if (await this.app.vault.adapter.exists(normalized)) {
			return false;
		}

		await this.app.vault.adapter.write(normalized, content);
		return true;
	}

	private getBaseFiles(root: string): Array<{ path: string; content: string }> {
		return [
			{
				path: `${root}/wiki/index.md`,
				content: [
					'# Research Index',
					'',
					'Generated catalog for ingested knowledge artifacts.',
					'',
					'## Sources',
					'- Add or refresh source summaries under wiki/sources/ and list them here.',
					'',
					'## Concepts',
					'- Track concept pages under wiki/concepts/.'
				].join('\n')
			},
			{
				path: `${root}/wiki/log.md`,
				content: [
					'# Ingest Log',
					'',
					'Append-only chronological record of indexing and synthesis runs.',
					'',
					'| Date | Action | Input | Output | Notes |',
					'| --- | --- | --- | --- | --- |'
				].join('\n')
			},
			{
				path: `${root}/wiki/overview.md`,
				content: [
					'# Project Overview',
					'',
					'## Goals',
					'- Define what this research workspace is trying to answer.',
					'',
					'## Current Focus',
					'- Capture active hypotheses, blockers, and next experiments.',
					'',
					'## Retrieval Notes',
					'- Keep this note short so it can be used as high-signal RAG context.'
				].join('\n')
			},
			{
				path: `${root}/CLAUDE.md`,
				content: [
					'# Research Schema',
					'',
					'Use this schema when generating or updating markdown in this workspace.',
					'',
					'## Folder Contract',
					'- raw/: immutable source material',
					'- wiki/: generated knowledge notes and summaries',
					'- outputs/: final artifacts, reports, and presentations',
					'',
					'## Source Summary Template',
					'- Source metadata (title, author, url, date)',
					'- Abstract in 5-8 bullets',
					'- Key entities and concepts with links',
					'- Evidence quality notes',
					'',
					'## Comparison Template',
					'- Scope',
					'- Similarities',
					'- Differences',
					'- Decision guidance',
					'',
					'## Style',
					'- Prefer concise markdown with links between pages.',
					'- Keep paragraphs short for chunk-friendly retrieval.'
				].join('\n')
			},
			{
				path: `${root}/.gitignore`,
				content: [
					'# Binary/raw artifacts',
					'raw/data/',
					'raw/assets/',
					'raw/images/',
					'',
					'# Local exports',
					'outputs/*.pdf',
					'outputs/*.pptx',
					'outputs/*.docx'
				].join('\n')
			}
		];
	}

	private getTemplateFiles(root: string): Array<{ path: string; content: string }> {
		return [
			{
				path: `${root}/wiki/sources/_source-template.md`,
				content: [
					'# Source: {{title}}',
					'',
					'## Metadata',
					'- Author:',
					'- URL:',
					'- Date:',
					'',
					'## Summary',
					'- ',
					'',
					'## Evidence',
					'- ',
					'',
					'## Linked Concepts',
					'- [[concepts/{{concept-name}}]]'
				].join('\n')
			},
			{
				path: `${root}/wiki/concepts/_concept-template.md`,
				content: [
					'# Concept: {{name}}',
					'',
					'## Definition',
					'- ',
					'',
					'## Why it matters',
					'- ',
					'',
					'## Related entities',
					'- [[entities/{{entity-name}}]]',
					'',
					'## Source links',
					'- [[sources/{{source-name}}]]'
				].join('\n')
			},
			{
				path: `${root}/wiki/entities/_entity-template.md`,
				content: [
					'# Entity: {{name}}',
					'',
					'## Type',
					'- Person | Organization | Tool | Dataset',
					'',
					'## Description',
					'- ',
					'',
					'## Relationships',
					'- [[concepts/{{concept-name}}]]',
					'',
					'## Supporting sources',
					'- [[sources/{{source-name}}]]'
				].join('\n')
			},
			{
				path: `${root}/wiki/comparisons/_comparison-template.md`,
				content: [
					'# Comparison: {{option-a}} vs {{option-b}}',
					'',
					'## Scope',
					'- ',
					'',
					'## Similarities',
					'- ',
					'',
					'## Differences',
					'- ',
					'',
					'## Recommendation',
					'- '
				].join('\n')
			},
			{
				path: `${root}/outputs/_report-template.md`,
				content: [
					'# Report: {{topic}}',
					'',
					'## Executive summary',
					'- ',
					'',
					'## Findings',
					'- ',
					'',
					'## Risks and unknowns',
					'- ',
					'',
					'## Next actions',
					'- '
				].join('\n')
			}
		];
	}

	private async createResearchWorkspace(options: FirstRunScaffoldOptions): Promise<ScaffoldSummary> {
		const root = this.sanitizeVaultPath(options.rootFolder);
		const folders = [
			root,
			`${root}/raw`,
			`${root}/raw/articles`,
			`${root}/raw/papers`,
			`${root}/raw/repos`,
			`${root}/raw/data`,
			`${root}/raw/images`,
			`${root}/raw/assets`,
			`${root}/wiki`,
			`${root}/wiki/concepts`,
			`${root}/wiki/entities`,
			`${root}/wiki/sources`,
			`${root}/wiki/comparisons`,
			`${root}/outputs`
		];

		let createdFolders = 0;
		for (const folder of folders) {
			const created = await this.ensureFolder(folder);
			if (created) {
				createdFolders += 1;
			}
		}

		let createdFiles = 0;
		const baseFiles = this.getBaseFiles(root);
		for (const file of baseFiles) {
			const created = await this.createFileIfMissing(file.path, file.content);
			if (created) {
				createdFiles += 1;
			}
		}

		if (options.createTemplates) {
			const templateFiles = this.getTemplateFiles(root);
			for (const template of templateFiles) {
				const created = await this.createFileIfMissing(template.path, template.content);
				if (created) {
					createdFiles += 1;
				}
			}
		}

		this.plugin.settings.hasCompletedFirstRunWizard = true;
		this.plugin.settings.researchWorkspaceRoot = root;
		await this.plugin.saveSettings();

		if (options.openOverviewAfterCreate) {
			const overviewPath = `${root}/wiki/overview.md`;
			const overviewFile = this.app.vault.getAbstractFileByPath(overviewPath);
			if (overviewFile instanceof TFile) {
				await this.app.workspace.getLeaf(true).openFile(overviewFile);
			}
		}

		return {
			createdFiles,
			createdFolders,
			rootFolder: root
		};
	}
}
