import { App, Modal, Notice } from 'obsidian';
import { voidAsync } from '../utils/asyncUtils';

export interface EditorActionResultModalConfig {
	actionTitle: string;
	response: string;
	applyLabel: string;
	onApply: () => void | Promise<void>;
	onSave: () => void | Promise<void>;
}

export class EditorActionResultModal extends Modal {
	private readonly config: EditorActionResultModalConfig;

	constructor(app: App, config: EditorActionResultModalConfig) {
		super(app);
		this.config = config;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('local-llm-editor-result-modal');

		contentEl.createEl('h2', { text: `Noesis ${this.config.actionTitle}` });

		const body = contentEl.createDiv({ cls: 'local-llm-editor-result-body' });
		const responseArea = body.createEl('textarea', { cls: 'local-llm-editor-result-textarea' });
		responseArea.value = this.config.response;

		const actions = contentEl.createDiv({ cls: 'local-llm-editor-result-actions' });

		const closeButton = actions.createEl('button', {
			text: 'Close',
			attr: { type: 'button' }
		});

		const saveButton = actions.createEl('button', {
			text: 'Save response as note',
			attr: { type: 'button' }
		});

		const applyButton = actions.createEl('button', {
			text: this.config.applyLabel,
			cls: 'mod-cta',
			attr: { type: 'button' }
		});

		closeButton.addEventListener('click', () => this.close());

		saveButton.addEventListener('click', voidAsync(async () => {
			saveButton.disabled = true;
			applyButton.disabled = true;
			try {
				await this.config.onSave();
			} catch (error) {
				new Notice(`Failed to save response: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				saveButton.disabled = false;
				applyButton.disabled = false;
			}
		}));

		applyButton.addEventListener('click', voidAsync(async () => {
			saveButton.disabled = true;
			applyButton.disabled = true;
			try {
				await this.config.onApply();
				this.close();
			} catch (error) {
				new Notice(`Failed to apply response: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				saveButton.disabled = false;
				applyButton.disabled = false;
			}
		}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
