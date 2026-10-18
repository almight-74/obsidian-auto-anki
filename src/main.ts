import {
	App,
	Editor,
	MarkdownView,
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	TFile,
	setIcon,
} from 'obsidian';

import {
	AiProvider,
	ConflictPolicy,
	PluginSettings,
	DEFAULT_SETTINGS,
} from './settings';

import { AnkiDeckModal, CardGenerator, ExportModal } from './modal';
// import {
//     electronEncrypt,
//     electronDecrypt,
// } from './utils/enc';
import { ANKI_CONNECT_DEFAULT_PORT } from './utils/anki';
import { isNumeric } from './utils/validations';
import { StatusBarElement } from './utils/cusom-types';
import { CardInformation, checkGpt, convertNotesToFlashcards } from './utils/gpt';
import { convertNotesToFlashcardsWithClaude } from './utils/claude';
import { EMPTY_SYNC_STATE, LineRange, SyncEngine, SyncReport, SyncState } from './sync/engine';

function mergeDefaults<T>(defaults: T, data: unknown): T {
	if (typeof data !== 'object' || data == null) return structuredClone(defaults);
	const out = structuredClone(defaults) as Record<string, unknown>;
	Object.entries(data as Record<string, unknown>).forEach(([k, v]) => {
		const d = out[k];
		out[k] = (typeof d === 'object' && d != null && !Array.isArray(d)) ? mergeDefaults(d, v) : v;
	});
	return out as T;
}

function makeKeyIdentifier(value: string) {
	return value.length >= 7 ? `${value.slice(0,3)}...${value.slice(-4)}` : 'xxxx';
}

export default class AutoAnkiPlugin extends Plugin {
	settings: PluginSettings;
	syncState: SyncState;
	syncEngine: SyncEngine;
	statusBar: StatusBarElement;
	statusBarIcon: HTMLElement;
	autoSyncHandle: number | null = null;
	
	async onload() {
		await this.loadSettings();
				
		this.addSettingTab(new AutoAnkiSettingTab(this.app, this));

		this.statusBar = this.addStatusBarItem();
		this.statusBar.className = 'status-bar-auto-anki'
		this.statusBarIcon = this.statusBar.createEl('span', { cls: 'status-bar-icon' });
		this.statusBar.createEl('div', { text: 'auto-anki' });
		this.statusBar.doReset = () => {
			setIcon(this.statusBarIcon, 'check-circle-2');
			this.statusBar.classList.remove('--running');
			this.statusBar.classList.remove('--error');
		};
		this.statusBar.doDisplayError = () => {
			setIcon(this.statusBarIcon, 'alert-circle');
			this.statusBar.classList.remove('--running');
			this.statusBar.classList.add('--error');
			
		}
		this.statusBar.doDisplayRunning = () => {
			setIcon(this.statusBarIcon, 'refresh-cw');
			this.statusBar.classList.remove('--error');
			this.statusBar.classList.add('--running');
		};
		this.statusBar.doReset();

		this.syncEngine = new SyncEngine(
			this.app,
			() => ({
				port: this.port(),
				defaultDeck: this.settings.ankiDestinationDeck,
				sync: this.settings.sync,
			}),
			() => this.syncState,
			() => this.saveAll(),
		);

		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (file instanceof TFile) this.syncEngine.onRename(oldPath, file.path);
		}));

		this.addRibbonIcon('refresh-cw', 'Sync flashcards with Anki', () => this.runSync('vault'));

		this.addCommand({
			id: 'sync-current-file-with-anki',
			name: 'Sync current note with Anki',
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view?.file == null) return false;
				if (!checking) this.runSync('file', view);
				return true;
			},
		});

		this.addCommand({
			id: 'sync-selection-with-anki',
			name: 'Sync selected cards with Anki',
			editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView) => {
				if (editor.getSelection().length === 0) return false;
				if (!checking) {
					const range = { from: editor.getCursor('from').line, to: editor.getCursor('to').line };
					this.runSync('file', view, range);
				}
				return true;
			},
		});

		this.addCommand({
			id: 'sync-vault-with-anki',
			name: 'Sync all flashcard notes with Anki',
			callback: () => this.runSync('vault'),
		});

		this.addCommand({
			id: 'export-current-file-to-anki',
			name: 'Generate cards with AI from current note',
			checkCallback: (checking: boolean) => {
				if (this.aiGenerator() == null) {
					return false;
				}

				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view == null) {
					return false;
				}

				if (!checking) {
					if (view.data.length <= 0) {
						new Notice('There is nothing in the file!');
						return;
					}
					const defaults = this.settings.questionGenerationDefaults.file;
					this.openAiModal(view, view.data, null, defaults.numQuestions, defaults.numAlternatives);
				}

				return true;
			},
		});

		this.addCommand({
			id: 'export-text-selection-to-anki',
			name: 'Generate cards with AI from selection',
			editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView) => {
				const currTextSelection = editor.getSelection();

				if (this.aiGenerator() == null) {
					return false;
				}

				if (!checking) {
					if (currTextSelection.length == 0) {
						new Notice('No text was selected!');
						return;
					}
					const defaults = this.settings.questionGenerationDefaults.textSelection;
					this.openAiModal(view, currTextSelection, currTextSelection, defaults.numQuestions, defaults.numAlternatives);
				}

				return true;
			},
		});

		this.setupAutoSync();
	}
	
	onunload() {
	}

	port() {
		return this.settings.ankiConnectPort || ANKI_CONNECT_DEFAULT_PORT;
	}

	setupAutoSync() {
		if (this.autoSyncHandle != null) window.clearInterval(this.autoSyncHandle);
		this.autoSyncHandle = null;
		const minutes = this.settings.sync.autoSyncMinutes;
		if (minutes > 0) {
			this.autoSyncHandle = window.setInterval(() => {
				if (!this.syncEngine.isBusy) this.runSync('vault', undefined, undefined, true);
			}, minutes * 60 * 1000);
			this.registerInterval(this.autoSyncHandle);
		}
	}

	async runSync(scope: 'file' | 'vault', view?: MarkdownView, range?: LineRange, quiet = false) {
		this.statusBar.doDisplayRunning?.();
		let report: SyncReport;
		try {
			if (scope === 'file' && view?.file) {
				// flush unsaved editor changes so the sync reads what's on screen
				await view.save();
				report = await this.syncEngine.syncFile(view.file, range);
			}
			else {
				report = await this.syncEngine.syncVault();
			}
		}
		catch (err) {
			this.statusBar.doDisplayError?.();
			new Notice(`Anki sync failed: ${err.message}`);
			return;
		}

		if (report.errors.length > 0) this.statusBar.doDisplayError?.();
		else this.statusBar.doReset?.();

		const changed = report.added + report.updated + report.pulled + report.deleted;
		if (quiet && changed === 0 && report.errors.length === 0) return;
		const parts = [
			`${report.added} added`,
			`${report.updated} updated in Anki`,
			`${report.pulled} updated from Anki`,
		];
		if (report.deleted > 0) parts.push(`${report.deleted} deleted`);
		const errors = report.errors.length > 0 ? `\n\nErrors:\n${report.errors.slice(0, 5).join('\n')}` : '';
		new Notice(`Anki sync: ${parts.join(', ')}${errors}`, errors ? 10000 : 4000);
	}

	aiGenerator(): CardGenerator | null {
		const s = this.settings;
		if (s.aiProvider === 'anthropic') {
			const key = s.anthropicApiKey;
			if (!key) return null;
			return (notes, nq, nsets) => convertNotesToFlashcardsWithClaude(key, s.anthropicModel, notes, nq, nsets);
		}
		const key = s.openAiApiKey;
		if (!key) return null;
		return async (notes, nq, nsets) => {
			if (!checkGpt(key)) return [];
			return convertNotesToFlashcards(key, notes, nq, nsets, s.gptAdvancedOptions);
		};
	}

	openAiModal(view: MarkdownView, data: string, selection: string | null, numQuestions: number, numAlternatives: number) {
		const generate = this.aiGenerator();
		const file = view.file;
		if (generate == null || file == null) return;

		const onConfirm = (cards: CardInformation[]) => {
			if (cards.length === 0) return;
			if (this.settings.aiInsertIntoNote) {
				this.insertCardsAndSync(file, cards, selection);
			}
			else {
				new AnkiDeckModal(this.app, this.port(), this.settings.ankiDestinationDeck, cards).open();
			}
		};

		new ExportModal(
			this.app,
			this.statusBar,
			data,
			this.port(),
			generate,
			onConfirm,
			numQuestions,
			numAlternatives,
		).open();
	}

	// writes generated cards into the note as `Q::A` lines, then syncs just those lines
	async insertCardsAndSync(file: TFile, cards: CardInformation[], selection: string | null) {
		const sep = this.settings.sync.basicSeparator;
		const clean = (t: string) => t.replace(/\r?\n/g, '<br>').split(sep).join(':').trim();
		const cardLines = cards.map((c) => `${clean(c.q)}${sep}${clean(c.a)}`);

		let range: LineRange = { from: 0, to: 0 };
		await this.app.vault.process(file, (data) => {
			let insertAt = data.length;
			if (selection) {
				const idx = data.indexOf(selection);
				if (idx >= 0) {
					const lineEnd = data.indexOf('\n', idx + selection.length);
					insertAt = lineEnd < 0 ? data.length : lineEnd;
				}
			}
			const before = data.slice(0, insertAt);
			const block = `${before.endsWith('\n') || before.length === 0 ? '' : '\n'}\n${cardLines.join('\n')}\n`;
			const from = (before + block).split('\n').length - 1 - cardLines.length;
			range = { from, to: from + cardLines.length - 1 };
			return before + block + data.slice(insertAt);
		});

		this.statusBar.doDisplayRunning?.();
		try {
			const report = await this.syncEngine.syncFile(file, range);
			if (report.errors.length > 0) {
				this.statusBar.doDisplayError?.();
				new Notice(`Cards inserted, but sync had errors:\n${report.errors.slice(0, 5).join('\n')}`, 10000);
			}
			else {
				this.statusBar.doReset?.();
				new Notice(`Inserted and synced ${report.added} card(s) to Anki`);
			}
		}
		catch (err) {
			this.statusBar.doDisplayError?.();
			new Notice(`Cards inserted, but sync failed: ${err.message}`);
		}
	}
	
	async loadSettings() {
		const data = (await this.loadData()) ?? {};
		const { syncState, ...settings } = data;
		this.settings = mergeDefaults(DEFAULT_SETTINGS, settings);
		this.syncState = mergeDefaults(EMPTY_SYNC_STATE, syncState);
	}

	async saveAll() {
		await this.saveData({ ...this.settings, syncState: this.syncState });
	}
	
	async saveSettings() {
		await this.saveAll();
	}
}

class AutoAnkiSettingTab extends PluginSettingTab {
	plugin: AutoAnkiPlugin;
	maxFilesSetting: Setting;
	
	constructor(app: App, plugin: AutoAnkiPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	
	display(): void {
		const { containerEl } = this;
		
		containerEl.empty();

		const ankiDescription = document.createElement('div');
        // use innerHTML for harcoded description
		ankiDescription.innerHTML = '<p><a href="https://apps.ankiweb.net/">Anki</a> is an open-source flashcard program that is popular for spaced repetition. This plugin has only been tested on desktop, and requires <a href="https://foosoft.net/projects/anki-connect/">Anki Connect</a> to be installed alongside the main Anki program.</p><p>Enabling this plugin adds commands to sync flashcards written in your notes with Anki in both directions, and to optionally generate new flashcards with Claude or OpenAI\'s GPT models.</p><p>For information on usage, see <a href="https://github.com/ad2969/obsidian-auto-anki#readme">the instructions</a> online.</p>';
        containerEl.appendChild(ankiDescription)

		const syncHelp = containerEl.createEl('div');
		syncHelp.createEl('p', { text: 'Write cards anywhere in a note and run "Sync current note with Anki" or "Sync selected cards with Anki":' });
		const syncHelpList = syncHelp.createEl('ul');
		syncHelpList.createEl('li', { text: 'Question::Answer - basic card' });
		syncHelpList.createEl('li', { text: 'Question:::Answer - basic card plus reversed card' });
		syncHelpList.createEl('li', { text: 'A line with ==highlighted== words - cloze card' });
		syncHelp.createEl('p', { text: 'Synced cards get an invisible <!--anki:ID--> marker. Edits on either side sync both ways. Set "anki-deck" in a note\'s frontmatter to override the deck.' });
		
		new Setting(containerEl)
			.setName('Anki Port')
			.setDesc('The port number used to host Anki Connect')
			.addText(textComponent => textComponent
				.setPlaceholder('Anki Connect Default: 8765')
				.setValue(String(this.plugin.settings.ankiConnectPort))
				.onChange(async (value) => {
					this.plugin.settings.ankiConnectPort = Number(value);
					await this.plugin.saveSettings();
				})
			);
		
		containerEl.createEl('h2', { text: 'Sync' });

		new Setting(containerEl)
			.setName('Tags')
			.setDesc('Tags added to new Anki notes (space or comma separated).')
			.addText(t => t
				.setValue(this.plugin.settings.sync.tags)
				.onChange(async (value) => {
					this.plugin.settings.sync.tags = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Conflict resolution')
			.setDesc('When the same card was edited in both Obsidian and Anki since the last sync.')
			.addDropdown(d => d
				.addOption('newest', 'Newest edit wins')
				.addOption('obsidian', 'Obsidian wins')
				.addOption('anki', 'Anki wins')
				.setValue(this.plugin.settings.sync.conflictPolicy)
				.onChange(async (value) => {
					this.plugin.settings.sync.conflictPolicy = value as ConflictPolicy;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Vault sync tag')
			.setDesc('"Sync all flashcard notes" syncs notes that already contain synced cards, plus notes with this tag. Leave empty to only use already-synced notes.')
			.addText(t => t
				.setPlaceholder('flashcards')
				.setValue(this.plugin.settings.sync.vaultSyncTag)
				.onChange(async (value) => {
					this.plugin.settings.sync.vaultSyncTag = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Delete Anki notes removed from Obsidian')
			.setDesc('During "Sync all flashcard notes", delete Anki notes whose card line no longer exists anywhere in the vault. Off = the note is kept in Anki and just stops syncing.')
			.addToggle(t => t
				.setValue(this.plugin.settings.sync.deleteRemovedNotes)
				.onChange(async (value) => {
					this.plugin.settings.sync.deleteRemovedNotes = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Auto sync interval (minutes)')
			.setDesc('Run "Sync all flashcard notes" periodically. 0 = off.')
			.addText(t => t
				.setValue(String(this.plugin.settings.sync.autoSyncMinutes))
				.onChange(async (value) => {
					if (value !== '' && !isNumeric(value)) {
						new Notice('The value you entered is not a number value');
						return;
					}
					this.plugin.settings.sync.autoSyncMinutes = Math.max(0, Number(value));
					await this.plugin.saveSettings();
					this.plugin.setupAutoSync();
				})
			);

		new Setting(containerEl)
			.setName('Highlights as cloze cards')
			.setDesc('Turn lines containing ==highlights== into cloze cards.')
			.addToggle(t => t
				.setValue(this.plugin.settings.sync.clozeHighlights)
				.onChange(async (value) => {
					this.plugin.settings.sync.clozeHighlights = value;
					await this.plugin.saveSettings();
				})
			);

		const textSetting = (name: string, desc: string, key: 'basicSeparator' | 'reversedSeparator' | 'basicModel' | 'reversedModel' | 'clozeModel') => {
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText(t => t
					.setPlaceholder(DEFAULT_SETTINGS.sync[key])
					.setValue(this.plugin.settings.sync[key])
					.onChange(async (value) => {
						this.plugin.settings.sync[key] = value || DEFAULT_SETTINGS.sync[key];
						await this.plugin.saveSettings();
					})
				);
		};
		textSetting('Basic separator', 'Separator between question and answer.', 'basicSeparator');
		textSetting('Reversed separator', 'Separator for cards that also get a reversed card.', 'reversedSeparator');
		textSetting('Basic note type', 'Anki note type for basic cards (first field = question, second = answer).', 'basicModel');
		textSetting('Reversed note type', 'Anki note type for reversed cards.', 'reversedModel');
		textSetting('Cloze note type', 'Anki note type for cloze cards (first field = text).', 'clozeModel');

		containerEl.createEl('h2', { text: 'AI card generation' });

		new Setting(containerEl)
			.setName('AI provider')
			.addDropdown(d => d
				.addOption('anthropic', 'Claude (Anthropic)')
				.addOption('openai', 'OpenAI GPT')
				.setValue(this.plugin.settings.aiProvider)
				.onChange(async (value) => {
					this.plugin.settings.aiProvider = value as AiProvider;
					await this.plugin.saveSettings();
				})
			);

		const anthropicDescription = new DocumentFragment();
		const anthropicDescHtml = document.createElement('p');
		// use innerHTML for harcoded description
		anthropicDescHtml.innerHTML = 'The API key for your Anthropic account. Get one <a href="https://console.anthropic.com/settings/keys">here</a>.';
		anthropicDescription.appendChild(anthropicDescHtml);

		new Setting(containerEl)
			.setName('Anthropic API Key')
			.setDesc(anthropicDescription)
			.addText(textComponent => textComponent
				.setPlaceholder(this.plugin.settings.anthropicApiKeyIdentifier ? `key entered: ${this.plugin.settings.anthropicApiKeyIdentifier}` : 'NO_KEY_ENTERED')
				.onChange(async (value) => {
					this.plugin.settings.anthropicApiKey = value || null;
					this.plugin.settings.anthropicApiKeyIdentifier = value ? makeKeyIdentifier(value) : '';
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Claude model')
			.setDesc('Model id used for generation, e.g. claude-opus-5-5, claude-sonnet-5-5 or claude-haiku-5-5 (cheapest).')
			.addText(t => t
				.setPlaceholder(DEFAULT_SETTINGS.anthropicModel)
				.setValue(this.plugin.settings.anthropicModel)
				.onChange(async (value) => {
					this.plugin.settings.anthropicModel = value.trim() || DEFAULT_SETTINGS.anthropicModel;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Insert generated cards into note')
			.setDesc('On: chosen cards are written into the note as Question::Answer lines and synced (fully tracked). Off: sent straight to Anki without tracking.')
			.addToggle(t => t
				.setValue(this.plugin.settings.aiInsertIntoNote)
				.onChange(async (value) => {
					this.plugin.settings.aiInsertIntoNote = value;
					await this.plugin.saveSettings();
				})
			);

		const openAiDescription = new DocumentFragment();
		const openAiDescHtml = document.createElement('p');
        // use innerHTML for harcoded description
		openAiDescHtml.innerHTML = 'The API Key associated with your OpenAI account, used for querying GPT. Go <a href="https://platform.openai.com/account/api-keys">here</a> to obtain one.';
		openAiDescription.appendChild(openAiDescHtml);

		new Setting(containerEl)
			.setName('OpenAI API Key')
			.setDesc(openAiDescription)
			.addText(textComponent => textComponent
				.setPlaceholder(`key entered: ${this.plugin.settings.openAiApiKeyIdentifier}` ?? 'NO_KEY_ENTERED')
				.onChange(async (value) => {
					// this.plugin.settings.openAiApiKey = electronEncrypt(value);
					this.plugin.settings.openAiApiKey = value;
                    this.plugin.settings.openAiApiKeyIdentifier = makeKeyIdentifier(value);
					await this.plugin.saveSettings();
				})
			);

        containerEl.createEl('h2', { text: 'Default Options for Exporting' });
		
		new Setting(containerEl)
			.setName('Anki Default Deck Name')
			.setDesc('The name of the deck in Anki you want to export flashcards to, by default')
			.addText(textComponent => textComponent
				.setPlaceholder('Default')
				.setValue(String(this.plugin.settings.ankiDestinationDeck))
				.onChange(async (value) => {
					this.plugin.settings.ankiDestinationDeck = value;
					await this.plugin.saveSettings();
				})
			);

        containerEl.createEl('p', { text: '--> For exporting full files' });
        
		new Setting(containerEl)
            .setName('Number of Questions')
            .setDesc('The number of questions to generate from the file.')
            .addText(textComponent => textComponent
                .setValue(String(this.plugin.settings.questionGenerationDefaults.file.numQuestions))
                .onChange(async (value) => {
					if (value == '') {
						this.plugin.settings.questionGenerationDefaults.file.numQuestions = 0;
						await this.plugin.saveSettings();
					}
					else if (!isNumeric(value)) {
						new Notice('The value you entered is not a number value');
					}
					else {
						this.plugin.settings.questionGenerationDefaults.file.numQuestions = Number(value);
						await this.plugin.saveSettings();
					}
                })
            );

		new Setting(containerEl)
			.setName('Number of Alternatives')
			.setDesc('The number of alternatives to generate for each question. Zero means no alteratives.')
			.addText(textComponent => textComponent
				.setValue(String(this.plugin.settings.questionGenerationDefaults.file.numAlternatives))
				.onChange(async (value) => {
					if (value == '') {
						this.plugin.settings.questionGenerationDefaults.file.numAlternatives = 0;
						await this.plugin.saveSettings();
					}
					else if (!isNumeric(value)) {
						new Notice('The value you entered is not a number value');
					}
					else {
						this.plugin.settings.questionGenerationDefaults.file.numAlternatives = Number(value);
						await this.plugin.saveSettings();
					}
				})
			);

        containerEl.createEl('p', { text: '--> For exporting selected text' });
        
		new Setting(containerEl)
            .setName('Number of Questions')
            .setDesc('The number of questions to generate from the selected text.')
            .addText(textComponent => textComponent
                .setValue(String(this.plugin.settings.questionGenerationDefaults.textSelection.numQuestions))
                .onChange(async (value) => {
					if (value == '') {
						this.plugin.settings.questionGenerationDefaults.textSelection.numQuestions = 0;
						await this.plugin.saveSettings();
					}
					else if (!isNumeric(value)) {
						new Notice('The value you entered is not a number value');
					}
					else {
						this.plugin.settings.questionGenerationDefaults.textSelection.numQuestions = Number(value);
						await this.plugin.saveSettings();
					}
                })
            );

		new Setting(containerEl)
			.setName('Number of Alternatives')
			.setDesc('The number of alternatives to generate for each question. Zero means no alteratives.')
			.addText(textComponent => textComponent
				.setValue(String(this.plugin.settings.questionGenerationDefaults.textSelection.numAlternatives))
				.onChange(async (value) => {
					if (value == '') {
						this.plugin.settings.questionGenerationDefaults.textSelection.numAlternatives = 0;
						await this.plugin.saveSettings();
					}
					else if (!isNumeric(value)) {
						new Notice('The value you entered is not a number value');
					}
					else {
						this.plugin.settings.questionGenerationDefaults.textSelection.numAlternatives = Number(value);
						await this.plugin.saveSettings();
					}
				})
			);

        containerEl.createEl('h2', { text: 'Advanced Options for OpenAI\'s GPT Models' });

        // See OpenAI docs for more info:
        // https://platform.openai.com/docs/api-reference/completions
        const tempValComponent = createEl('span', {
			text: String(this.plugin.settings.gptAdvancedOptions.temperature),
			cls: 'slider-val', // used to make custom slider component with displayed value next to it
		});
        const tempComponent = new Setting(containerEl)
            .setName('Temperature')
            .setDesc('The sampling temperature used. Higher values increases randomness, while lower values makes the output more deterministic. (Default = 1)')
            .addSlider(sliderComponent => sliderComponent
                .setValue(this.plugin.settings.gptAdvancedOptions.temperature)
                .setLimits(0, 2, 0.1)
                .onChange(async (value) => {
                    this.plugin.settings.gptAdvancedOptions.temperature = value;
                    tempValComponent.textContent = String(value);
                    await this.plugin.saveSettings();
                })
            );
        tempComponent.settingEl.appendChild(tempValComponent);

        const topPValComponent = createEl('span', {
			text: String(this.plugin.settings.gptAdvancedOptions.top_p),
			cls: 'slider-val',
		});
        const topPComponent = new Setting(containerEl)
            .setName('Top P')
            .setDesc('Value for nucleus sampling. Lower values mean the output considers the tokens comprising higher probability mass. (Default = 1)')
            .addSlider(sliderComponent => sliderComponent
                .setValue(this.plugin.settings.gptAdvancedOptions.top_p)
                .setLimits(0, 1, 0.05)
                .onChange(async (value) => {
                    this.plugin.settings.gptAdvancedOptions.top_p = value;
                    topPValComponent.textContent = String(value);
                    await this.plugin.saveSettings();
                })
            );
        topPComponent.settingEl.appendChild(topPValComponent);

        const fPenaltyValComponent = createEl('span', {
			text: String(this.plugin.settings.gptAdvancedOptions.frequency_penalty),
			cls: 'slider-val',
		});
        const fPenaltyComponent = new Setting(containerEl)
            .setName('Frequency Penalty')
            .setDesc('Positive values penalize new tokens based on their existing frequency in the text so far. Higher values decrease chance of \'repetition\'. (Default = 0)')
            .addSlider(sliderComponent => sliderComponent
                .setValue(this.plugin.settings.gptAdvancedOptions.frequency_penalty)
                .setLimits(-2, 2, 0.1)
                .onChange(async (value) => {
                    this.plugin.settings.gptAdvancedOptions.frequency_penalty = value;
                    fPenaltyValComponent.textContent = String(value);
                    await this.plugin.saveSettings();
                })
            );
        fPenaltyComponent.settingEl.appendChild(fPenaltyValComponent);

        const pPenaltyValComponent = createEl('span', {
			text: String(this.plugin.settings.gptAdvancedOptions.presence_penalty),
			cls: 'slider-val',
		});
		const pPenaltyComponent = new Setting(containerEl)
            .setName('Presence Penalty')
            .setDesc('Positive values penalize new tokens based on whether they appear in the text so far. Higher values increase chance of \'creativity\'. (Default = 0)')
            .addSlider(sliderComponent => sliderComponent
                .setValue(this.plugin.settings.gptAdvancedOptions.presence_penalty)
                .setLimits(-2, 2, 0.1)
                .onChange(async (value) => {
                    this.plugin.settings.gptAdvancedOptions.presence_penalty = value;
                    pPenaltyValComponent.textContent = String(value);
                    await this.plugin.saveSettings();
                })
            );
        pPenaltyComponent.settingEl.appendChild(pPenaltyValComponent);


        const openAiTokenDescription = new DocumentFragment();
        const openAiTokenDescHtml = document.createElement('p');
        // use innerHTML for harcoded description
        openAiTokenDescHtml.innerHTML = 'The maximum number of tokens consumed for each question. See <a href="https://platform.openai.com/tokenizer">tokens</a> to better understand how tokens are quantized. (Default = 16)';
        openAiTokenDescription.appendChild(openAiTokenDescHtml);

        new Setting(containerEl)
            .setName('Maximum Tokens per Question')
            .setDesc(openAiTokenDescription)
            .addText(textComponent => textComponent
                .setValue(String(this.plugin.settings.gptAdvancedOptions.max_tokens_per_question))
                .onChange(async (value) => {
					if (value == '') {
						this.plugin.settings.gptAdvancedOptions.max_tokens_per_question = DEFAULT_SETTINGS.gptAdvancedOptions.max_tokens_per_question;
						await this.plugin.saveSettings();
					}
					else if (!isNumeric(value)) {
						new Notice('The value you entered is not a number value');
					}
					else {
						this.plugin.settings.gptAdvancedOptions.max_tokens_per_question = Number(value);
						await this.plugin.saveSettings();
					}
                })
            );
	}
}
