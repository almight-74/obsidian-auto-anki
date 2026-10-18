import {
    App,
    Editor,
    EditorPosition,
    EditorSuggest,
    EditorSuggestContext,
    EditorSuggestTriggerInfo,
    Modal,
    Setting,
    TFile,
} from 'obsidian';

import { ankiInvoke } from './utils/anki';
import { splitTags } from './sync/parser';

// Deck and tag names from Anki, refreshed at most once a minute
export class AnkiCache {
    private decks: { at: number; value: Promise<string[]> } | null = null;
    private tags: { at: number; value: Promise<string[]> } | null = null;

    constructor(private getPort: () => number) {}

    private load(action: string) {
        return ankiInvoke<string[]>(this.getPort(), action).then((v) => [...v].sort(), () => []);
    }

    getDecks() {
        if (!this.decks || Date.now() - this.decks.at > 60_000) this.decks = { at: Date.now(), value: this.load('deckNames') };
        return this.decks.value;
    }

    getTags() {
        if (!this.tags || Date.now() - this.tags.at > 60_000) this.tags = { at: Date.now(), value: this.load('getTags') };
        return this.tags.value;
    }

    invalidate() {
        this.decks = null;
        this.tags = null;
    }
}

export function noteDefaults(app: App, file: TFile, fallbackDeck: string) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    const deck = typeof fm?.['anki-deck'] === 'string' && fm['anki-deck'].trim() ? fm['anki-deck'].trim() : fallbackDeck;
    const rawTags = fm?.['anki-tags'];
    const tags = Array.isArray(rawTags) ? rawTags.map(String) : typeof rawTags === 'string' ? splitTags(rawTags) : [];
    return { deck, tags };
}

let pickerId = 0;

// deck field with autocomplete + tag chips with autocomplete
export class DeckTagPicker {
    deck: string;
    tags: string[];

    constructor(container: HTMLElement, cache: AnkiCache, deck: string, tags: string[]) {
        this.deck = deck;
        this.tags = [...tags];
        const id = `aa-picker-${++pickerId}`;

        const deckList = container.createEl('datalist', { attr: { id: `${id}-decks` } });
        cache.getDecks().then((decks) => decks.forEach((d) => deckList.createEl('option', { attr: { value: d } })));
        new Setting(container)
            .setName('Deck')
            .setDesc('Pick an Anki deck or type a new name (use :: for sub-decks).')
            .addText((t) => {
                t.setValue(this.deck).onChange((v) => { this.deck = v.trim(); });
                t.inputEl.setAttr('list', `${id}-decks`);
                t.inputEl.addClass('aa-picker-input');
            });

        const tagList = container.createEl('datalist', { attr: { id: `${id}-tags` } });
        cache.getTags().then((tagNames) => tagNames.forEach((tag) => tagList.createEl('option', { attr: { value: tag } })));
        const tagSetting = new Setting(container)
            .setName('Tags')
            .setDesc('Press Enter, space or comma to add a tag.');
        const box = tagSetting.controlEl.createDiv({ cls: 'aa-tag-box' });
        const chips = box.createDiv({ cls: 'aa-tag-chips' });
        const input = box.createEl('input', { type: 'text', cls: 'aa-picker-input', attr: { list: `${id}-tags`, placeholder: 'add tag' } });

        const renderChips = () => {
            chips.empty();
            this.tags.forEach((tag) => {
                const chip = chips.createSpan({ cls: 'aa-tag-chip', text: tag });
                const remove = chip.createSpan({ cls: 'aa-tag-chip__remove', text: '×' });
                remove.onclick = () => { this.tags = this.tags.filter((x) => x !== tag); renderChips(); };
            });
        };
        const commit = () => {
            splitTags(input.value).forEach((tag) => { if (!this.tags.includes(tag)) this.tags.push(tag); });
            input.value = '';
            renderChips();
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === ',') { e.preventDefault(); commit(); }
            else if (e.key === 'Backspace' && input.value === '' && this.tags.length > 0) { this.tags.pop(); renderChips(); }
        });
        // picking from the suggestion list fires change without a key press
        input.addEventListener('change', commit);
        input.addEventListener('blur', commit);
        renderChips();
    }
}

export interface SyncDialogResult {
    deck: string;
    tags: string[];
    applyToAll: boolean;
    saveAsDefault: boolean;
}

export class SyncOptionsModal extends Modal {
    private applyToAll = false;
    private saveAsDefault = false;

    constructor(
        app: App,
        private cache: AnkiCache,
        private summary: { total: number; fresh: number; scope: string },
        private defaults: { deck: string; tags: string[] },
        private onConfirm: (r: SyncDialogResult) => void,
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        const { total, fresh, scope } = this.summary;
        contentEl.createEl('h2', { text: `Sync ${scope} with Anki` });
        contentEl.createEl('p', { text: `${total} card(s) found: ${fresh} new, ${total - fresh} already synced.` });

        const picker = new DeckTagPicker(contentEl, this.cache, this.defaults.deck, this.defaults.tags);

        new Setting(contentEl)
            .setName('Apply to')
            .addDropdown((d) => d
                .addOption('new', 'New cards only')
                .addOption('all', 'All cards here (moves synced cards, adds tags)')
                .setValue('new')
                .onChange((v) => { this.applyToAll = v === 'all'; })
            );

        new Setting(contentEl)
            .setName('Save as this note\'s default')
            .setDesc('Stores anki-deck / anki-tags in the note\'s frontmatter for future cards.')
            .addToggle((t) => t.setValue(false).onChange((v) => { this.saveAsDefault = v; }));

        new Setting(contentEl)
            .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
            .addButton((b) => b
                .setButtonText(total === 0 ? 'Nothing to sync' : 'Sync')
                .setCta()
                .setDisabled(total === 0)
                .onClick(() => {
                    this.close();
                    this.onConfirm({
                        deck: picker.deck || this.defaults.deck,
                        tags: picker.tags,
                        applyToAll: this.applyToAll,
                        saveAsDefault: this.saveAsDefault,
                    });
                })
            );
    }

    onClose() {
        this.contentEl.empty();
    }
}

// autocomplete for {{deck::...}} and {{tag::...}} while typing
export class CardFieldSuggest extends EditorSuggest<string> {
    private kind: 'deck' | 'tag' = 'deck';

    constructor(app: App, private cache: AnkiCache) {
        super(app);
    }

    onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
        const before = editor.getLine(cursor.line).slice(0, cursor.ch);
        const m = before.match(/\{\{(deck|tags?)::([^}]*)$/i);
        if (!m) return null;
        this.kind = m[1].toLowerCase() === 'deck' ? 'deck' : 'tag';
        // decks match the whole value, tags only the word being typed
        const query = this.kind === 'deck' ? m[2] : (m[2].split(/[\s,]/).pop() ?? '');
        return { start: { line: cursor.line, ch: cursor.ch - query.length }, end: cursor, query };
    }

    async getSuggestions(ctx: EditorSuggestContext) {
        const all = this.kind === 'deck' ? await this.cache.getDecks() : await this.cache.getTags();
        const q = ctx.query.toLowerCase();
        return all.filter((v) => v.toLowerCase().includes(q)).slice(0, 50);
    }

    renderSuggestion(value: string, el: HTMLElement) {
        el.setText(value);
    }

    selectSuggestion(value: string) {
        const ctx = this.context;
        if (!ctx) return;
        const after = ctx.editor.getLine(ctx.end.line).slice(ctx.end.ch);
        const closing = this.kind === 'deck' && !after.startsWith('}}') ? '}}' : '';
        ctx.editor.replaceRange(value + closing, ctx.start, ctx.end);
        const ch = ctx.start.ch + value.length + closing.length;
        ctx.editor.setCursor({ line: ctx.start.line, ch });
    }
}
