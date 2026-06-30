import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import LocalLLMPlugin from '@/main';
import {
	DEFAULT_WORKSPACE_PROFILE_TEMPLATE_ID,
	getWorkspaceProfileTemplateById,
	WORKSPACE_PROFILE_OPTIONS,
	type WorkspaceProfileTemplate,
	type WorkspaceProfileTemplateId
} from '@/templates/firstRunWorkspaceProfiles';
import { voidAsync } from '@/utils/asyncUtils';

interface FirstRunScaffoldOptions {
	rootFolder: string;
	templateId: WorkspaceProfileTemplateId;
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
	private readonly noesisTemplatesRootFolder = 'Noesis Templates';
	private rootFolder: string;
	private selectedTemplateId: WorkspaceProfileTemplateId = DEFAULT_WORKSPACE_PROFILE_TEMPLATE_ID;
	private createTemplates: boolean = true;
	private openOverviewAfterCreate: boolean = true;

	constructor(app: App, plugin: LocalLLMPlugin) {
		super(app);
		this.plugin = plugin;
		const defaultTemplate = getWorkspaceProfileTemplateById(this.selectedTemplateId);
		this.rootFolder = plugin.settings.researchWorkspaceRoot || defaultTemplate.defaultRootFolder;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('noesis-first-run-wizard');

		contentEl.createEl('h2', { text: 'Noesis Research Wizard' });
		contentEl.createEl('p', {
			text: 'Create a workspace in your vault with a starter structure and optional markdown templates.'
		});

		const templateDescriptionEl = contentEl.createEl('p', {
			cls: 'noesis-first-run-template-description'
		});

		const previewEl = contentEl.createEl('pre', {
			cls: 'noesis-first-run-structure-preview',
			text: ''
		});

		const renderTemplatePreview = () => {
			const template = getWorkspaceProfileTemplateById(this.selectedTemplateId);
			templateDescriptionEl.setText(template.description);
			previewEl.setText(this.buildStructurePreview(this.sanitizeVaultPath(this.rootFolder, template.defaultRootFolder), template));
		};

		new Setting(contentEl)
			.setName('Workspace profile')
			.setDesc('Select a starter structure to scaffold in your vault.')
			.addDropdown((dropdown) => {
				for (const option of WORKSPACE_PROFILE_OPTIONS) {
					dropdown.addOption(option.id, option.label);
				}

				dropdown.setValue(this.selectedTemplateId).onChange((value) => {
					this.selectedTemplateId = value as WorkspaceProfileTemplateId;
					renderTemplatePreview();
				});
			});

		new Setting(contentEl)
			.setName('Workspace root folder')
			.setDesc('Vault-relative path. Leave blank to use the profile default root.')
			.addText((text) => {
				text.setPlaceholder('my-research')
					.setValue(this.rootFolder)
					.onChange((value) => {
						this.rootFolder = value;
						renderTemplatePreview();
					});
			});

		renderTemplatePreview();

		new Setting(contentEl)
			.setName('Create starter templates')
			.setDesc('Adds markdown templates specific to the selected profile.')
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
		skipButton.addEventListener('click', voidAsync(async () => {
			this.plugin.settings.hasCompletedFirstRunWizard = true;
			await this.plugin.saveSettings();
			new Notice('First-run wizard skipped. Use command palette to reopen it anytime.');
			this.close();
		}));

		const createButton = actions.createEl('button', {
			text: 'Create Workspace',
			cls: 'mod-cta'
		});
		createButton.addEventListener('click', voidAsync(async () => {
			createButton.disabled = true;
			skipButton.disabled = true;
			try {
				const summary = await this.createResearchWorkspace({
					rootFolder: this.rootFolder,
					templateId: this.selectedTemplateId,
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
		}));
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private sanitizeVaultPath(pathValue: string, fallback: string = 'my-research'): string {
		const normalized = pathValue.replace(/\\/g, '/').trim().replace(/^\/+/, '').replace(/\/+$/, '');
		if (!normalized) {
			return fallback;
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

		const folderPath = normalized.split('/').slice(0, -1).join('/');
		if (folderPath) {
			await this.ensureFolder(folderPath);
		}

		await this.app.vault.adapter.write(normalized, content);
		return true;
	}

	private getTemplateSetupGuideContent(templatesFolderPath: string): string {
		return [
			'# Noesis Templates Setup',
			'',
			'Noesis created starter note templates in this folder, but Obsidian does not auto-select a template folder.',
			'',
			'## Set Template Folder Location (manual)',
			'1. Open Settings in Obsidian.',
			'2. Go to Core Plugins and enable Templates (if it is off).',
			'3. Open Templates settings.',
			`4. Set Template folder location to: ${templatesFolderPath}`,
			'5. Optional: enable Trigger template on new file if you want automatic insertion.',
			'',
			'## Template Organization',
			'- Templates are stored directly in this single folder.',
			'- File names include profile/path context so templates from different profiles can coexist.',
			'- You can rename templates if needed; Noesis only writes missing files.',
			'',
			'## Re-running The Wizard',
			'- Running the wizard again with another profile adds new templates here.',
			'- Existing templates are not overwritten.'
		].join('\n');
	}

	private getCentralizedTemplateFileName(templatePath: string): string {
		const normalized = this.sanitizeVaultPath(templatePath)
			.replace(/\//g, '__')
			.replace(/[\\:*?"<>|]/g, '-');

		return normalized || 'noesis-template.md';
	}

	private buildStructurePreview(root: string, template: WorkspaceProfileTemplate): string {
		const visibleFolders = template.folders.slice(0, 10);
		const hiddenFolderCount = Math.max(template.folders.length - visibleFolders.length, 0);
		const lines: string[] = [`${root}/`];

		for (const folder of visibleFolders) {
			lines.push(`  ${folder}/`);
		}

		if (hiddenFolderCount > 0) {
			lines.push(`  ... (+${hiddenFolderCount} more folders)`);
		}

		if (template.baseFiles.length > 0) {
			lines.push('');
			lines.push('Starter files:');
			for (const file of template.baseFiles.slice(0, 3)) {
				lines.push(`  ${file.path}`);
			}
		}

		return lines.join('\n');
	}

	private async createResearchWorkspace(options: FirstRunScaffoldOptions): Promise<ScaffoldSummary> {
		const template = getWorkspaceProfileTemplateById(options.templateId);
		const root = this.sanitizeVaultPath(options.rootFolder, template.defaultRootFolder);
		const templatesRoot = this.sanitizeVaultPath(this.noesisTemplatesRootFolder);
		const folders = [
			root,
			templatesRoot,
			...template.folders.map((folder) => this.sanitizeVaultPath(`${root}/${folder}`))
		];

		let createdFolders = 0;
		for (const folder of folders) {
			const created = await this.ensureFolder(folder);
			if (created) {
				createdFolders += 1;
			}
		}

		let createdFiles = 0;
		for (const file of template.baseFiles) {
			const created = await this.createFileIfMissing(`${root}/${file.path}`, file.content);
			if (created) {
				createdFiles += 1;
			}
		}

		const guideCreated = await this.createFileIfMissing(
			`${templatesRoot}/README - Set Obsidian Template Folder.md`,
			this.getTemplateSetupGuideContent(templatesRoot)
		);
		if (guideCreated) {
			createdFiles += 1;
		}

		if (options.createTemplates) {
			for (const templateFile of template.templateFiles) {
				const templateFileName = this.getCentralizedTemplateFileName(templateFile.path);
				const created = await this.createFileIfMissing(`${templatesRoot}/${templateFileName}`, templateFile.content);
				if (created) {
					createdFiles += 1;
				}
			}
		}

		this.plugin.settings.hasCompletedFirstRunWizard = true;
		this.plugin.settings.researchWorkspaceRoot = root;
		await this.plugin.saveSettings();

		if (options.openOverviewAfterCreate) {
			const candidatePaths = new Set<string>(['wiki/overview.md', 'overview.md', 'README.md']);
			for (const baseFile of template.baseFiles) {
				candidatePaths.add(baseFile.path);
			}

			for (const candidatePath of candidatePaths) {
				const candidateFile = this.app.vault.getAbstractFileByPath(`${root}/${candidatePath}`);
				if (candidateFile instanceof TFile) {
					await this.app.workspace.getLeaf(true).openFile(candidateFile);
					break;
				}
			}
		}

		return {
			createdFiles,
			createdFolders,
			rootFolder: root
		};
	}
}
