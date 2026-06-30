import { Editor, EventRef, MarkdownFileInfo, MarkdownView, Menu, Notice, setIcon } from 'obsidian';
import { LoggingUtility } from '../utils/LoggingUtility';
import type LocalLLMPlugin from '../main';
import { EditorActionResultModal } from '../views/EditorActionResultModal';
import { DEFAULT_RESPONSE_NOTE_TEMPLATE, renderTemplateVariables } from '../utils/TemplateVariableRenderer';

type EditorActionId = 'explain' | 'rewrite' | 'summarize' | 'create-tasks' | 'insert-response';

interface EditorActionDefinition {
	id: EditorActionId;
	commandId: string;
	commandName: string;
	menuTitle: string;
	menuIcon: string;
	buildPrompt: (selection: string) => string;
	handlingMode: 'replace-selection' | 'insert-below-cursor';
	applyButtonLabel: string;
	prefix?: string;
	successNotice: string;
}

const ACTIONS: EditorActionDefinition[] = [
	{
		id: 'explain',
		commandId: 'editor-explain-selection',
		commandName: 'Editor: Explain selection',
		menuTitle: 'Noesis: Explain selection',
		menuIcon: 'info',
		buildPrompt: (selection) =>
			`Explain the following note selection in plain language. Keep it concise and practical.\n\nSelection:\n"""\n${selection}\n"""`,
		handlingMode: 'insert-below-cursor',
		applyButtonLabel: 'Paste under highlighted section',
		prefix: '### Explanation\n',
		successNotice: 'Explanation inserted under cursor'
	},
	{
		id: 'rewrite',
		commandId: 'editor-rewrite-selection',
		commandName: 'Editor: Rewrite selection',
		menuTitle: 'Noesis: Rewrite selection',
		menuIcon: 'pen-line',
		buildPrompt: (selection) =>
			`Rewrite the following text to improve clarity and flow while preserving its meaning and tone. Return only the rewritten text.\n\nText:\n"""\n${selection}\n"""`,
		handlingMode: 'replace-selection',
		applyButtonLabel: 'Replace now',
		successNotice: 'Selection rewritten'
	},
	{
		id: 'summarize',
		commandId: 'editor-summarize-selection',
		commandName: 'Editor: Summarize selection',
		menuTitle: 'Noesis: Summarize selection',
		menuIcon: 'list',
		buildPrompt: (selection) =>
			`Summarize the following text into 3 to 5 concise bullet points. Use markdown list formatting.\n\nText:\n"""\n${selection}\n"""`,
		handlingMode: 'insert-below-cursor',
		applyButtonLabel: 'Paste under highlighted section',
		prefix: '### Summary\n',
		successNotice: 'Summary inserted under cursor'
	},
	{
		id: 'create-tasks',
		commandId: 'editor-create-tasks-from-selection',
		commandName: 'Editor: Create tasks from selection',
		menuTitle: 'Noesis: Create tasks from selection',
		menuIcon: 'check-square',
		buildPrompt: (selection) =>
			`Convert the following text into an actionable markdown task list. Return only tasks in "- [ ]" format.\n\nText:\n"""\n${selection}\n"""`,
		handlingMode: 'insert-below-cursor',
		applyButtonLabel: 'Paste under highlighted section',
		prefix: '### Tasks\n',
		successNotice: 'Task list inserted under cursor'
	},
	{
		id: 'insert-response',
		commandId: 'editor-insert-response-under-cursor',
		commandName: 'Editor: Insert response under cursor',
		menuTitle: 'Noesis: Insert response under cursor',
		menuIcon: 'sparkles',
		buildPrompt: (selection) =>
			`Respond helpfully to the following selected note content. Return markdown that can be pasted directly below the current cursor.\n\nSelected content:\n"""\n${selection}\n"""`,
		handlingMode: 'insert-below-cursor',
		applyButtonLabel: 'Paste under highlighted section',
		successNotice: 'AI response inserted under cursor'
	}
];

interface EditorPosition {
	line: number;
	ch: number;
}

export class EditorNativeActionsService {
	constructor(private readonly plugin: LocalLLMPlugin) {}

	register(): void {
		const workspaceEvents = this.plugin.app.workspace as unknown as {
			on: (eventName: string, callback: (...args: any[]) => void) => EventRef;
		};

		for (const action of ACTIONS) {
			this.plugin.addCommand({
				id: action.commandId,
				name: action.commandName,
				editorCheckCallback: (checking, editor, view) => {
					if (!this.hasSelection(editor)) {
						return false;
					}

					if (!checking) {
						void this.runAction(action, editor, view, 'command');
					}

					return true;
				}
			});
		}

		this.plugin.registerEvent(
			workspaceEvents.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView) => {
				if (!this.hasSelection(editor)) {
					return;
				}

				menu.addSeparator();
				for (const action of ACTIONS) {
					menu.addItem((item) => {
						item
							.setTitle(action.menuTitle)
							.setIcon(action.menuIcon)
							.onClick(() => {
								void this.runAction(action, editor, view, 'context-menu');
							});
					});
				}
			})
		);

		LoggingUtility.log('Editor native actions service registered', {
			actions: ACTIONS.map((action) => action.id)
		});
	}

	private hasSelection(editor: Editor): boolean {
		return editor.getSelection().trim().length > 0;
	}

	private async runAction(
		action: EditorActionDefinition,
		editor: Editor,
		view: MarkdownView | MarkdownFileInfo | null | undefined,
		source: 'command' | 'context-menu'
	): Promise<void> {
		const selection = editor.getSelection().trim();
		if (!selection) {
			new Notice('Select text first to use Noesis editor actions');
			return;
		}

		if (!this.plugin.llmService) {
			LoggingUtility.error('Editor action aborted; LLM service is unavailable', { action: action.id, source });
			new Notice('Noesis is still initializing. Try again in a moment.');
			return;
		}

		const filePath = view?.file?.path ?? 'unknown-file';
		const cursor = editor.getCursor('to');
		const selectionFrom = editor.getCursor('from');
		const selectionTo = editor.getCursor('to');
		LoggingUtility.log('Editor action started', {
			action: action.id,
			source,
			filePath,
			cursor,
			selectionLength: selection.length
		});

		const removeIndicator = this.showWorkingIndicator(view, action.id);

		try {
			const response = await this.plugin.llmService.sendMessage(action.buildPrompt(selection));
			const sanitized = response.trim();

			if (!sanitized) {
				LoggingUtility.warn('Editor action produced empty response', { action: action.id, filePath });
				new Notice('Noesis returned an empty response');
				return;
			}

			LoggingUtility.log('Editor action completed', {
				action: action.id,
				source,
				filePath,
				responseLength: sanitized.length,
				handlingMode: action.handlingMode
			});

			this.openResultModal({
				action,
				response: sanitized,
				editor,
				view,
				selection,
				selectionFrom,
				selectionTo,
				filePath
			});
		} catch (error: unknown) {
			LoggingUtility.error('Editor action failed', {
				action: action.id,
				source,
				filePath,
				error
			});
			new Notice('Noesis action failed. Check endpoint and logs.');
		} finally {
			removeIndicator();
		}
	}

	private openResultModal(options: {
		action: EditorActionDefinition;
		response: string;
		editor: Editor;
		view: MarkdownView | MarkdownFileInfo | null | undefined;
		selection: string;
		selectionFrom: EditorPosition;
		selectionTo: EditorPosition;
		filePath: string;
	}): void {
		const {
			action,
			response,
			editor,
			view,
			selection,
			selectionFrom,
			selectionTo,
			filePath
		} = options;

		const actionTitle = action.commandName.replace('Editor: ', '');
		new EditorActionResultModal(this.plugin.app, {
			actionTitle,
			response,
			applyLabel: action.applyButtonLabel,
			onApply: async () => {
				if (action.handlingMode === 'replace-selection') {
					editor.replaceRange(response, selectionFrom, selectionTo);
				} else {
					const prefixed = `${action.prefix ?? ''}${response}`;
					editor.replaceRange(`\n\n${prefixed}\n`, selectionTo);
				}

				LoggingUtility.log('Editor action applied from modal', {
					action: action.id,
					filePath,
					handlingMode: action.handlingMode
				});
				new Notice(action.successNotice);
			},
			onSave: async () => {
				const savedPath = await this.saveResponseAsNote({
					action,
					response,
					editor,
					view,
					selection,
					selectionTo,
					fallbackFilePath: filePath
				});
				new Notice(`Saved response note: ${savedPath}`);
			}
		}).open();
	}

	private async saveResponseAsNote(options: {
		action: EditorActionDefinition;
		response: string;
		editor: Editor;
		view: MarkdownView | MarkdownFileInfo | null | undefined;
		selection: string;
		selectionTo: EditorPosition;
		fallbackFilePath: string;
	}): Promise<string> {
		const { action, response, editor, view, selection, selectionTo, fallbackFilePath } = options;
		const sourceFile = this.resolveSourceFilePath(view, fallbackFilePath);
		const blockId = `noesis-${Date.now().toString(36)}`;
		const lineText = editor.getLine(selectionTo.line) ?? '';

		// Create a stable block anchor at the selected section so the saved note can deep-link back.
		if (!lineText.includes(`^${blockId}`)) {
			const anchorPrefix = lineText.trim().length === 0 ? '' : ' ';
			editor.replaceRange(`${anchorPrefix}^${blockId}`, { line: selectionTo.line, ch: lineText.length });
		}

		const sourceLinkTarget = this.toWikilinkTarget(sourceFile);
		const sourceLink = `[[${sourceLinkTarget}#^${blockId}|Jump to highlighted section]]`;
		const safeSelection = selection
			.split('\n')
			.map((line) => `> ${line}`)
			.join('\n');
		const template = this.plugin.settings.enableResponseNoteTemplate
			? (this.plugin.settings.responseNoteTemplate || DEFAULT_RESPONSE_NOTE_TEMPLATE)
			: DEFAULT_RESPONSE_NOTE_TEMPLATE;
		const actionTitle = `Noesis ${action.commandName.replace('Editor: ', '')}`;
		const noteBody = renderTemplateVariables(template, {
			action_title: actionTitle,
			source_link: sourceLink,
			generated_at: new Date().toISOString(),
			highlighted_text: safeSelection,
			response,
			source_file: sourceFile,
			source_block_id: blockId,
			source_excerpt: selection
		}).replace(/\s+$/, '') + '\n';

		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const baseName = `Noesis ${action.id} ${timestamp}.md`;
		const targetPath = this.getAvailableVaultPath(baseName);
		await this.plugin.app.vault.create(targetPath, noteBody);
		const responseLink = `[[${this.toWikilinkTarget(targetPath)}|Open generated response]]`;
		this.insertBacklinkNearSelection(editor, selectionTo.line, responseLink);

		LoggingUtility.log('Editor action response saved as note', {
			action: action.id,
			targetPath,
			sourceFile,
			sourceLink,
			responseLink
		});

		return targetPath;
	}

	private resolveSourceFilePath(view: MarkdownView | MarkdownFileInfo | null | undefined, fallbackFilePath: string): string {
		if (view?.file?.path) {
			return view.file.path;
		}

		const activeMarkdownView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeMarkdownView?.file?.path) {
			return activeMarkdownView.file.path;
		}

		return fallbackFilePath;
	}

	private getAvailableVaultPath(preferredPath: string): string {
		let candidate = preferredPath;
		let counter = 1;
		while (this.plugin.app.vault.getAbstractFileByPath(candidate)) {
			candidate = preferredPath.replace(/\.md$/, `-${counter}.md`);
			counter += 1;
		}

		return candidate;
	}

	private toWikilinkTarget(filePath: string): string {
		return filePath.replace(/\\/g, '/').replace(/\.md$/i, '');
	}

	private insertBacklinkNearSelection(editor: Editor, sourceLine: number, responseLink: string): void {
		const lineCount = Math.max(1, editor.lineCount());
		const safeLine = Math.max(0, Math.min(sourceLine, lineCount - 1));
		const currentLine = editor.getLine(safeLine) ?? '';
		const nextLine = safeLine + 1 < lineCount ? editor.getLine(safeLine + 1) ?? '' : '';

		if (currentLine.includes(responseLink) || nextLine.includes(responseLink)) {
			return;
		}

		const insertAt = { line: safeLine, ch: currentLine.length };
		editor.replaceRange(`\n- Noesis response: ${responseLink}`, insertAt);
	}

	private showWorkingIndicator(
		view: MarkdownView | MarkdownFileInfo | null | undefined,
		actionId: EditorActionId
	): () => void {
		const hostEl = this.getEditorHostElement(view);
		if (!hostEl) {
			LoggingUtility.warn('Unable to show editor action indicator; no editor host element', { actionId });
			return () => undefined;
		}

		const selectionRect = this.getSelectionRectWithinHost(hostEl);
		if (!selectionRect) {
			LoggingUtility.warn('Unable to show editor action indicator; selection rect not found', { actionId });
			return () => undefined;
		}

		const activeDocument = hostEl.ownerDocument;
		const indicator = activeDocument.createElement('div');
		indicator.className = 'local-llm-editor-action-indicator';
		indicator.setAttribute('role', 'status');
		indicator.setAttribute('aria-live', 'polite');

		const spinner = indicator.createDiv({ cls: 'local-llm-editor-action-indicator-icon' });
		setIcon(spinner, 'loader');
		const label = indicator.createSpan({ cls: 'local-llm-editor-action-indicator-label', text: 'Working' });
		label.setAttribute('aria-hidden', 'true');

		const hostRect = hostEl.getBoundingClientRect();
		const top = selectionRect.top - hostRect.top - 28;
		const left = selectionRect.left - hostRect.left + Math.min(selectionRect.width / 2, 90);

		indicator.style.top = `${Math.max(4, top)}px`;
		indicator.style.left = `${Math.max(4, left)}px`;

		hostEl.appendChild(indicator);

		return () => {
			indicator.remove();
		};
	}

	private getEditorHostElement(view: MarkdownView | MarkdownFileInfo | null | undefined): HTMLElement | null {
		const maybeView = view as MarkdownView;
		if (maybeView && this.isHTMLElementCrossWindow(maybeView.contentEl)) {
			return maybeView.contentEl;
		}

		const activeMarkdownView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (this.isHTMLElementCrossWindow(activeMarkdownView?.contentEl)) {
			return activeMarkdownView.contentEl;
		}

		return null;
	}

	private isHTMLElementCrossWindow(value: unknown): value is HTMLElement {
		if (!value || typeof value !== 'object') {
			return false;
		}

		const maybeElement = value as { ownerDocument?: Document };
		const defaultView = maybeElement.ownerDocument?.defaultView;
		if (!defaultView) {
			return false;
		}

		return value instanceof defaultView.HTMLElement;
	}

	private getSelectionRectWithinHost(hostEl: HTMLElement): DOMRect | null {
		const selection = window.getSelection();
		if (selection && selection.rangeCount > 0) {
			const rangeRect = selection.getRangeAt(0).getBoundingClientRect();
			if (rangeRect.width > 0 && rangeRect.height > 0 && this.rectOverlapsHost(rangeRect, hostEl)) {
				return rangeRect;
			}
		}

		const highlighted = hostEl.querySelector<HTMLElement>('.cm-selectionBackground, .cm-selectionLayer .cm-selectionBackground');
		if (highlighted) {
			const cmRect = highlighted.getBoundingClientRect();
			if (cmRect.width > 0 && cmRect.height > 0) {
				return cmRect;
			}
		}

		return null;
	}

	private rectOverlapsHost(rect: DOMRect, hostEl: HTMLElement): boolean {
		const hostRect = hostEl.getBoundingClientRect();
		return !(rect.right < hostRect.left || rect.left > hostRect.right || rect.bottom < hostRect.top || rect.top > hostRect.bottom);
	}
}