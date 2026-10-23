import {
	App,
	Editor,
	MarkdownView,
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	SecretComponent,
	TFile,
	setIcon,
} from 'obsidian';

import {
	AiProvider,
	Conciseness,
	ConflictPolicy,
	Difficulty,
	FieldDisplay,
	PluginSettings,
	DEFAULT_SETTINGS,
} from './settings';

import { AnkiDeckModal, CardGenerator, CardTarget, ExportModal, HeadingPickerModal, NoteHeading } from './modal';
// import {
//     electronEncrypt,
//     electronDecrypt,
// } from './utils/enc';
import { ANKI_CONNECT_DEFAULT_PORT, ankiInvoke } from './utils/anki';
import { isNumeric } from './utils/validations';
import { StatusBarElement } from './utils/cusom-types';
import { CardInformation, checkGpt, convertNotesToFlashcards, testOpenAi } from './utils/gpt';
import { convertNotesToFlashcardsWithClaude, testClaude } from './utils/claude';
import { compactNotes, parseHeadings, sectionLines } from './utils/text';
import { cardFieldsExtension, wrapCardFields } from './editor';
import { AnkiCache, CardFieldSuggest, SyncOptionsModal, noteDefaults } from './ui';
import { applyDeckAndTags, parseCards } from './sync/parser';

const FIELD_DISPLAY_LABELS: Record<FieldDisplay, string> = {
	show: 'Show',
	dim: 'Dim',
	hide: 'Hide (shown on the line being edited)',
};
import { EMPTY_SYNC_STATE, LineRange, SyncEngine, SyncReport, SyncState, countLegacyRecords } from './sync/engine';

function mergeDefaults<T>(defaults: T, data: unknown): T {
	if (typeof data !== 'object' || data == null) return structuredClone(defaults);
	const out = structuredClone(defaults) as Record<string, unknown>;
	Object.entries(data as Record<string, unknown>).forEach(([k, v]) => {
		const d = out[k];
		out[k] = (typeof d === 'object' && d != null && !Array.isArray(d)) ? mergeDefaults(d, v) : v;
	});
	return out as T;
}

// plaintext key fields from older versions, moved into the keychain on load
const LEGACY_KEY_FIELDS = [
	{ key: 'anthropicApiKey', identifier: 'anthropicApiKeyIdentifier', secretId: 'anthropicSecretId' },
	{ key: 'openAiApiKey', identifier: 'openAiApiKeyIdentifier', secretId: 'openAiSecretId' },
] as const;

export default class AutoAnkiPlugin extends Plugin {
	settings: PluginSettings;
	syncState: SyncState;
	syncEngine: SyncEngine;
	ankiCache: AnkiCache;
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

		this.ankiCache = new AnkiCache(() => this.port());
		this.registerEditorSuggest(new CardFieldSuggest(this.app, this.ankiCache));
		this.registerEditorExtension(cardFieldsExtension(() => this.settings.fieldDisplay));
		this.registerMarkdownPostProcessor((el) => wrapCardFields(el));
		this.applyFieldDisplay();

		this.addCommand({
			id: 'toggle-card-fields',
			name: 'Toggle card fields (show / dim / hide)',
			callback: async () => {
				const order: FieldDisplay[] = ['show', 'dim', 'hide'];
				const next = order[(order.indexOf(this.settings.fieldDisplay) + 1) % order.length];
				await this.setFieldDisplay(next);
				new Notice(`Card fields: ${FIELD_DISPLAY_LABELS[next]}`);
			},
		});

		this.addCommand({
			id: 'test-anki-connection',
			name: 'Test connection to Anki',
			callback: async () => {
				const r = await this.testAnkiConnection();
				new Notice(r.message, r.ok ? 6000 : 10000);
			},
		});

		this.addCommand({
			id: 'sync-current-file-with-anki',
			name: 'Sync current note with Anki',
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view?.file == null) return false;
				if (!checking) this.syncWithDialog(view);
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
					this.syncWithDialog(view, range);
				}
				return true;
			},
		});

		this.addCommand({
			id: 'upgrade-older-cards',
			name: 'Update older cards to the latest format',
			callback: () => this.runSync('vault'),
		});

		// cards synced by an older version get deck / tag fields on the next vault sync
		this.app.workspace.onLayoutReady(() => {
			const legacy = countLegacyRecords(this.syncState);
			if (legacy > 0) {
				new Notice(`auto-anki: ${legacy} card(s) were synced by an older version. With Anki open, run "Update older cards to the latest format" to add their deck and tags.`, 15000);
			}
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
			id: 'generate-cards-from-headings',
			name: 'Generate cards with AI from headings',
			checkCallback: (checking: boolean) => {
				if (this.aiGenerator() == null) return false;
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view?.file == null) return false;
				if (!checking) this.openHeadingPicker(view);
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
		document.body.removeClass('aa-fields-show', 'aa-fields-dim', 'aa-fields-hide');
	}

	applyFieldDisplay() {
		document.body.removeClass('aa-fields-show', 'aa-fields-dim', 'aa-fields-hide');
		document.body.addClass(`aa-fields-${this.settings.fieldDisplay}`);
		// rebuilds editor decorations
		this.app.workspace.updateOptions();
	}

	async setFieldDisplay(display: FieldDisplay) {
		this.settings.fieldDisplay = display;
		await this.saveSettings();
		this.applyFieldDisplay();
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

	// asks for deck / tags first (unless turned off), writes them onto the cards, then syncs
	async syncWithDialog(view: MarkdownView, range?: LineRange) {
		const file = view.file;
		if (!file) return;
		if (!this.settings.syncDialog) return this.runSync('file', view, range);

		await view.save();
		const opts = { ...this.settings.sync };
		let cards = parseCards(await this.app.vault.read(file), opts);
		if (range) cards = cards.filter((c) => c.line >= range.from && c.line <= range.to);
		const defaults = noteDefaults(this.app, file, this.settings.ankiDestinationDeck || 'Default');

		new SyncOptionsModal(
			this.app,
			this.ankiCache,
			{ total: cards.length, fresh: cards.filter((c) => c.id == null).length, scope: range ? 'selection' : 'note' },
			defaults,
			async (r) => {
				const targets = r.applyToAll ? cards : cards.filter((c) => c.id == null);
				if (targets.length > 0) {
					await this.app.vault.process(file, (data) => {
						const lines = data.split('\n');
						for (const c of targets) {
							if (lines[c.line] === c.raw) lines[c.line] = applyDeckAndTags(c.raw, c.line, opts, r.deck, r.tags);
						}
						return lines.join('\n');
					});
				}
				await this.runSync('file', view, range);
				// frontmatter last: it can shift line numbers the sync relies on
				if (r.saveAsDefault) {
					await this.app.fileManager.processFrontMatter(file, (fm) => {
						fm['anki-deck'] = r.deck;
						if (r.tags.length > 0) fm['anki-tags'] = r.tags;
						else delete fm['anki-tags'];
					});
				}
			},
		).open();
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
			// new decks / tags may exist now
			this.ankiCache.invalidate();
		}
		catch (err) {
			this.statusBar.doDisplayError?.();
			new Notice(`Anki sync failed: ${err.message}`);
			return;
		}

		if (report.errors.length > 0) this.statusBar.doDisplayError?.();
		else this.statusBar.doReset?.();

		const changed = report.added + report.updated + report.pulled + report.deleted + report.upgraded;
		if (quiet && changed === 0 && report.errors.length === 0) return;
		const parts = [
			`${report.added} added`,
			`${report.updated} updated in Anki`,
			`${report.pulled} updated from Anki`,
		];
		if (report.deleted > 0) parts.push(`${report.deleted} deleted`);
		if (report.upgraded > 0) parts.push(`${report.upgraded} older card(s) upgraded`);
		const errors = report.errors.length > 0 ? `\n\nErrors:\n${report.errors.slice(0, 5).join('\n')}` : '';
		new Notice(`Anki sync: ${parts.join(', ')}${errors}`, errors ? 10000 : 4000);
	}

	// checks Anki Connect is reachable and that the note types used for sync exist
	async testAnkiConnection(): Promise<{ ok: boolean; message: string }> {
		const port = this.port();
		try {
			const version = await ankiInvoke<number>(port, 'version');
			const decks = await ankiInvoke<string[]>(port, 'deckNames');
			const models = await ankiInvoke<string[]>(port, 'modelNames');
			const { basicModel, reversedModel, clozeModel } = this.settings.sync;
			const missing = [basicModel, reversedModel, clozeModel].filter((m) => !models.includes(m));
			const deck = this.settings.ankiDestinationDeck;
			const lines = [`Connected to Anki Connect on port ${port} (API v${version}), ${decks.length} deck(s).`];
			if (deck && !decks.includes(deck)) lines.push(`Default deck "${deck}" doesn't exist yet; it will be created on first sync.`);
			if (missing.length > 0) {
				lines.push(`Missing note type(s): ${missing.join(', ')}. Fix the names under Sync settings.`);
				return { ok: false, message: lines.join('\n') };
			}
			return { ok: true, message: lines.join('\n') };
		}
		catch (err) {
			return {
				ok: false,
				message: `Could not reach Anki Connect on port ${port}.\nMake sure Anki is open and the Anki Connect add-on (code 2055492159) is installed, then restart Anki.\n(${err.message})`,
			};
		}
	}

	async testAi(): Promise<{ ok: boolean; message: string }> {
		const s = this.settings;
		if (s.aiProvider === 'anthropic') {
			const key = this.getSecret(s.anthropicSecretId);
			if (!key) return { ok: false, message: 'No Anthropic API key found. Pick or create one in "Anthropic API Key" below.' };
			return testClaude(key, s.anthropicModel);
		}
		const key = this.getSecret(s.openAiSecretId);
		if (!key) return { ok: false, message: 'No OpenAI API key found. Pick or create one in "OpenAI API Key" below.' };
		return testOpenAi(key);
	}

	getSecret(id: string) {
		return id ? this.app.secretStorage.getSecret(id) : null;
	}

	aiGenerator(): CardGenerator | null {
		const s = this.settings;
		if (s.aiProvider === 'anthropic') {
			const key = this.getSecret(s.anthropicSecretId);
			if (!key) return null;
			return (notes, nq, nsets, opts) => convertNotesToFlashcardsWithClaude(key, s.anthropicModel, compactNotes(notes), nq, nsets, opts);
		}
		const key = this.getSecret(s.openAiSecretId);
		if (!key) return null;
		return async (notes, nq, nsets, opts) => {
			if (!checkGpt(key)) return [];
			return convertNotesToFlashcards(key, compactNotes(notes), nq, nsets, s.gptAdvancedOptions, opts);
		};
	}

	openHeadingPicker(view: MarkdownView) {
		// read from the editor so headings typed moments ago are included
		const text = view.editor.getValue();
		const lines = text.split('\n');
		const all = parseHeadings(text);
		const flashcardsHeading = this.settings.aiHeading.trim().toLowerCase();
		const isFlashcards = (h: NoteHeading) => h.heading.trim().toLowerCase() === flashcardsHeading;
		const headings = all.filter((h) => !isFlashcards(h));
		if (headings.length === 0) {
			new Notice('This note has no headings');
			return;
		}

		new HeadingPickerModal(this.app, headings, (chosen) => {
			// overlapping picks (parent + child) are merged so text isn't sent twice
			const include = sectionLines(all, chosen, lines.length);
			// never send the generated-cards section back to the AI
			sectionLines(all, all.filter(isFlashcards), lines.length).forEach((i) => include.delete(i));
			const sectionText = lines.filter((_, i) => include.has(i)).join('\n');
			if (sectionText.trim().length === 0) {
				new Notice('The chosen sections are empty');
				return;
			}
			const defaults = this.settings.questionGenerationDefaults.textSelection;
			this.openAiModal(view, sectionText, null, defaults.numQuestions, defaults.numAlternatives);
		}).open();
	}

	openAiModal(view: MarkdownView, data: string, selection: string | null, numQuestions: number, numAlternatives: number) {
		const generate = this.aiGenerator();
		const file = view.file;
		if (generate == null || file == null) return;

		const defaults = noteDefaults(this.app, file, this.settings.ankiDestinationDeck || 'Default');
		const onConfirm = (cards: CardInformation[], target?: CardTarget) => {
			if (cards.length === 0) return;
			if (this.settings.aiInsertIntoNote) {
				this.insertCardsAndSync(file, cards, selection, target);
			}
			else {
				new AnkiDeckModal(this.app, this.port(), target?.deck ?? defaults.deck, cards).open();
			}
		};

		new ExportModal(
			this.app,
			this.statusBar,
			data,
			this.port(),
			generate,
			onConfirm,
			this.settings.generation,
			{ cache: this.ankiCache, ...defaults, sourcePath: file.path },
			numQuestions,
			numAlternatives,
		).open();
	}

	// writes generated cards into the note as `Q::A` lines, then syncs just those lines.
	// Cards go to the end of the configured heading's section (created if missing),
	// or right after the selection when no heading is set.
	async insertCardsAndSync(file: TFile, cards: CardInformation[], selection: string | null, target?: CardTarget) {
		const sep = this.settings.sync.basicSeparator;
		const clean = (t: string) => t
			.replace(/\r?\n/g, '<br>')
			.replace(/\{\{|\}\}/g, (m) => m.split('').join(' '))
			.split(sep).join(':')
			.trim();
		const cardLines = cards.map((c) => {
			const extra = c.extra ? clean(c.extra) : '';
			return `${clean(c.q)}${sep}${clean(c.a)}${extra ? ` {{extra::${extra}}}` : ''}`;
		}).map((line, i) => target ? applyDeckAndTags(line, i, this.settings.sync, target.deck, target.tags) : line);
		const heading = this.settings.aiHeading.trim();

		let range: LineRange = { from: 0, to: 0 };
		await this.app.vault.process(file, (data) => {
			const lines = data.split('\n');
			let at: number;

			if (heading) {
				const headingRegex = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
				let hIdx = -1;
				let level = 0;
				for (let i = 0; i < lines.length; i++) {
					const m = lines[i].replace(/\r$/, '').match(headingRegex);
					if (m && m[2].toLowerCase() === heading.toLowerCase()) { hIdx = i; level = m[1].length; break; }
				}
				if (hIdx >= 0) {
					let end = lines.length;
					for (let i = hIdx + 1; i < lines.length; i++) {
						const m = lines[i].replace(/\r$/, '').match(headingRegex);
						if (m && m[1].length <= level) { end = i; break; }
					}
					at = end;
					while (at > hIdx + 1 && lines[at - 1].trim() === '') at--;
					if (at === hIdx + 1) lines.splice(at++, 0, '');
					// keep a blank line before the next heading
					if (at < lines.length && lines[at].trim() !== '') lines.splice(at, 0, '');
				}
				else {
					while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
					if (lines.length > 0) lines.push('');
					lines.push(`## ${heading}`, '');
					at = lines.length;
					lines.push('');
				}
			}
			else {
				at = lines.length;
				const idx = selection ? data.indexOf(selection) : -1;
				if (idx >= 0) at = data.slice(0, idx + (selection ?? '').length).split('\n').length;
				lines.splice(at, 0, '');
				at++;
			}

			lines.splice(at, 0, ...cardLines);
			range = { from: at, to: at + cardLines.length - 1 };
			return lines.join('\n');
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
				new Notice(`Created ${report.added} card(s) in Anki:\n${cards.slice(0, 10).map((c) => `• ${c.q}`).join('\n')}${cards.length > 10 ? '\n…' : ''}`, 8000);
			}
		}
		catch (err) {
			this.statusBar.doDisplayError?.();
			new Notice(`Cards inserted, but sync failed: ${err.message}`);
		}
		await this.revealLines(file, range);
	}

	// opens the note and selects the given lines so new cards are visible
	async revealLines(file: TFile, range: LineRange) {
		let view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file !== file) {
			await this.app.workspace.getLeaf(false).openFile(file);
			view = this.app.workspace.getActiveViewOfType(MarkdownView);
		}
		if (view == null || view.file !== file) return;
		const editor = view.editor;
		// give the editor a moment to pick up the change written to disk
		window.setTimeout(() => {
			if (range.to >= editor.lineCount()) return;
			const from = { line: range.from, ch: 0 };
			const to = { line: range.to, ch: editor.getLine(range.to).length };
			editor.setSelection(from, to);
			editor.scrollIntoView({ from, to }, true);
		}, 200);
	}
	
	async loadSettings() {
		const data = (await this.loadData()) ?? {};
		const { syncState, ...settings } = data;

		let migrated = false;
		for (const f of LEGACY_KEY_FIELDS) {
			const value = settings[f.key];
			if (typeof value === 'string' && value.length > 0) {
				const secretId = settings[f.secretId] || DEFAULT_SETTINGS[f.secretId];
				try {
					this.app.secretStorage.setSecret(secretId, value);
					settings[f.secretId] = secretId;
				}
				catch (err) {
					// keep the plaintext key rather than lose it
					new Notice(`auto-anki: could not move API key into the keychain: ${err.message}`);
					continue;
				}
			}
			if (f.key in settings) migrated = true;
			delete settings[f.key];
			delete settings[f.identifier];
		}

		this.settings = mergeDefaults(DEFAULT_SETTINGS, settings);
		this.syncState = mergeDefaults(EMPTY_SYNC_STATE, syncState);
		if (migrated) await this.saveAll();
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

		const testSetting = new Setting(containerEl)
			.setName('Test Anki connection')
			.setDesc('Checks that Anki is running with Anki Connect, and that the note types used for sync exist.');
		const testResult = containerEl.createEl('div', { cls: 'anki-connection-result' });
		testSetting.addButton(btn => btn
			.setButtonText('Test connection')
			.setCta()
			.onClick(async () => {
				btn.setDisabled(true).setButtonText('Testing...');
				const r = await this.plugin.testAnkiConnection();
				btn.setDisabled(false).setButtonText('Test connection');
				testResult.setText(r.message);
				testResult.toggleClass('--ok', r.ok);
				testResult.toggleClass('--error', !r.ok);
			})
		);

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
			.setName('Ask for deck and tags when syncing a note')
			.setDesc('"Sync current note" and "Sync selected cards" first show a deck / tag picker.')
			.addToggle(t => t
				.setValue(this.plugin.settings.syncDialog)
				.onChange(async (value) => {
					this.plugin.settings.syncDialog = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Card fields in editor')
			.setDesc('How {{deck::}}, {{tag::}}, {{extra::}} and <!--anki:ID--> look in notes. Also: command "Toggle card fields".')
			.addDropdown(d => {
				(Object.keys(FIELD_DISPLAY_LABELS) as FieldDisplay[]).forEach((k) => d.addOption(k, FIELD_DISPLAY_LABELS[k]));
				d.setValue(this.plugin.settings.fieldDisplay)
					.onChange(async (value) => { await this.plugin.setFieldDisplay(value as FieldDisplay); });
			});

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

		const textSetting = (name: string, desc: string, key: 'basicSeparator' | 'reversedSeparator' | 'basicModel' | 'reversedModel' | 'clozeModel' | 'extraField') => {
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
		textSetting('Cloze note type', 'Anki note type for cloze cards (first field = text, second = extra).', 'clozeModel');
		textSetting('Extra field', 'Field in the basic/reversed note types that receives the extra text. If the note type has no such field, the extra is shown under the answer.', 'extraField');

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

		const aiTestSetting = new Setting(containerEl)
			.setName('Test AI connection')
			.setDesc('Checks the API key and model name. Uses no tokens.');
		const aiTestResult = containerEl.createEl('div', { cls: 'anki-connection-result' });
		aiTestSetting.addButton(btn => btn
			.setButtonText('Test AI')
			.onClick(async () => {
				btn.setDisabled(true).setButtonText('Testing...');
				const r = await this.plugin.testAi();
				btn.setDisabled(false).setButtonText('Test AI');
				aiTestResult.setText(r.message);
				aiTestResult.toggleClass('--ok', r.ok);
				aiTestResult.toggleClass('--error', !r.ok);
			})
		);

		const anthropicDescription = new DocumentFragment();
		const anthropicDescHtml = document.createElement('p');
		// use innerHTML for harcoded description
		anthropicDescHtml.innerHTML = 'Pick or create a secret in Obsidian\'s keychain holding your Anthropic API key. Get a key <a href="https://console.anthropic.com/settings/keys">here</a>.';
		anthropicDescription.appendChild(anthropicDescHtml);

		new Setting(containerEl)
			.setName('Anthropic API Key')
			.setDesc(anthropicDescription)
			.addComponent(el => new SecretComponent(this.app, el)
				.setValue(this.plugin.settings.anthropicSecretId)
				.onChange(async (value) => {
					this.plugin.settings.anthropicSecretId = value ?? '';
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

		new Setting(containerEl)
			.setName('Flashcards heading')
			.setDesc('Generated cards are added at the end of this heading\'s section, which is created if missing. Leave empty to insert right after the selection.')
			.addText(t => t
				.setPlaceholder('Flashcards')
				.setValue(this.plugin.settings.aiHeading)
				.onChange(async (value) => {
					this.plugin.settings.aiHeading = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Default difficulty')
			.addDropdown(d => d
				.addOption('easy', 'Easy (recall)')
				.addOption('medium', 'Medium (understanding)')
				.addOption('hard', 'Hard (application)')
				.setValue(this.plugin.settings.generation.difficulty)
				.onChange(async (value) => {
					this.plugin.settings.generation.difficulty = value as Difficulty;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Default answer length')
			.addDropdown(d => d
				.addOption('very-concise', 'Very concise')
				.addOption('concise', 'Concise')
				.addOption('detailed', 'Detailed')
				.setValue(this.plugin.settings.generation.conciseness)
				.onChange(async (value) => {
					this.plugin.settings.generation.conciseness = value as Conciseness;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Generate extra field')
			.setDesc('Add a short line of context or a mnemonic to each generated card, by default.')
			.addToggle(t => t
				.setValue(this.plugin.settings.generation.extra)
				.onChange(async (value) => {
					this.plugin.settings.generation.extra = value;
					await this.plugin.saveSettings();
				})
			);

		const openAiDescription = new DocumentFragment();
		const openAiDescHtml = document.createElement('p');
        // use innerHTML for harcoded description
		openAiDescHtml.innerHTML = 'Pick or create a secret in Obsidian\'s keychain holding your OpenAI API key, used for querying GPT. Go <a href="https://platform.openai.com/account/api-keys">here</a> to obtain one.';
		openAiDescription.appendChild(openAiDescHtml);

		new Setting(containerEl)
			.setName('OpenAI API Key')
			.setDesc(openAiDescription)
			.addComponent(el => new SecretComponent(this.app, el)
				.setValue(this.plugin.settings.openAiSecretId)
				.onChange(async (value) => {
					this.plugin.settings.openAiSecretId = value ?? '';
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
