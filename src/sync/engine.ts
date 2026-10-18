import { App, TFile, getAllTags } from 'obsidian';

import { SyncSettings } from 'src/settings';
import {
    AnkiNoteInfo,
    ankiInvoke,
    ankiMulti,
    notesInfo,
} from 'src/utils/anki';
import {
    CardType,
    ParsedCard,
    ParserOptions,
    formatCardLine,
    hasIdMarkers,
    parseCardLine,
    parseCards,
    setMetaOnLine,
    splitTags,
} from './parser';
import {
    clozeHtmlToMd,
    clozeMdToHtml,
    hashFields,
    htmlToMd,
    mdToHtml,
} from './convert';

export interface NoteSyncRecord {
    file: string;
    obsHash: string;   // hash of the fields as generated from Obsidian at last sync
    ankiHash: string;  // hash of the fields as stored in Anki at last sync
    v?: number;        // record format; missing = created before deck/tag sync
}

export const RECORD_VERSION = 2;

export function countLegacyRecords(state: SyncState) {
    return Object.values(state.notes).filter((r) => (r.v ?? 1) < RECORD_VERSION).length;
}

// Ids returned by Anki that have not been written into a file yet. Persisted
// before the file is touched, so a crash/edit race never creates duplicates.
export interface PendingId {
    file: string;
    obsHash: string;
    noteId: number;
}

export interface SyncState {
    notes: Record<string, NoteSyncRecord>;
    pending: PendingId[];
}

export const EMPTY_SYNC_STATE: SyncState = { notes: {}, pending: [] };

export interface SyncReport {
    added: number;
    updated: number;
    pulled: number;
    deleted: number;
    unchanged: number;
    upgraded: number;   // cards from older versions brought to the current format
    errors: string[];
    seenIds: Set<number>;
}

export interface LineRange {
    from: number;
    to: number;
}

interface CardWork {
    card: ParsedCard;
    model: string;
    fields: Record<string, string>;
    deck: string;
    tags: string[] | null;
    obsHash: string;
    id: number | null;
    needsMarker: boolean;   // id must be (re)written into the line
    replaces?: number;      // old note to delete once the replacement exists
}

interface LineEdit {
    line: number;
    raw: string;
    newLine: string;
    onApplied: () => void;
}

// used when the note type has no extra field: extra goes under the answer
const EXTRA_DIVIDER = '<hr id="auto-anki-extra">';
const EXTRA_DIVIDER_REGEX = /<hr[^>]*auto-anki-extra[^>]*>/i;

// deck and tags take part in change detection like fields do
const DECK_KEY = '\u0000deck';
const TAGS_KEY = '\u0000tags';

interface AnkiNoteState {
    info: AnkiNoteInfo;
    deck: string;
}

function sortedTags(tags: string[]) {
    return [...tags].sort().join(' ');
}

function ankiHashOf(s: AnkiNoteState) {
    const values: Record<string, string> = {};
    Object.entries(s.info.fields).forEach(([k, v]) => { values[k] = v.value; });
    return hashFields(s.info.modelName, { ...values, [DECK_KEY]: s.deck, [TAGS_KEY]: sortedTags(s.info.tags) });
}

function emptyReport(): SyncReport {
    return { added: 0, updated: 0, pulled: 0, deleted: 0, unchanged: 0, upgraded: 0, errors: [], seenIds: new Set() };
}

function ankiFieldValues(info: AnkiNoteInfo) {
    const out: Record<string, string> = {};
    Object.entries(info.fields).forEach(([k, v]) => { out[k] = v.value; });
    return out;
}

export class SyncEngine {
    private queue: Promise<unknown> = Promise.resolve();
    private fieldNameCache = new Map<string, string[]>();

    constructor(
        private app: App,
        private getSettings: () => { port: number; defaultDeck: string; sync: SyncSettings },
        private getState: () => SyncState,
        private saveState: () => Promise<void>,
    ) {}

    get isBusy() {
        return this.running > 0;
    }
    private running = 0;

    // serialise all syncs so two runs never race on the same file / state
    private exclusive<T>(fn: () => Promise<T>): Promise<T> {
        const run = async () => {
            this.running++;
            try { return await fn(); }
            finally { this.running--; }
        };
        const p = this.queue.then(run, run);
        this.queue = p.catch(() => undefined);
        return p;
    }

    syncFile(file: TFile, range?: LineRange) {
        return this.exclusive(async () => {
            this.fieldNameCache.clear();
            return this.syncFileUnlocked(file, range);
        });
    }

    syncVault() {
        return this.exclusive(async () => {
            this.fieldNameCache.clear();
            const { sync, port } = this.getSettings();
            const total = emptyReport();
            let hadFileErrors = false;

            for (const file of this.app.vault.getMarkdownFiles()) {
                if (!(await this.isFlashcardFile(file, sync.vaultSyncTag))) continue;
                const r = await this.syncFileUnlocked(file);
                total.added += r.added;
                total.updated += r.updated;
                total.pulled += r.pulled;
                total.unchanged += r.unchanged;
                total.upgraded += r.upgraded;
                total.errors.push(...r.errors.map((e) => `${file.path}: ${e}`));
                r.seenIds.forEach((id) => total.seenIds.add(id));
                if (r.errors.length > 0) hadFileErrors = true;
            }

            // notes whose card no longer exists anywhere in the vault
            // (skipped if any file failed, so a failed read never deletes notes)
            if (!hadFileErrors) {
                const state = this.getState();
                const orphans = Object.keys(state.notes).map(Number).filter((id) => !total.seenIds.has(id));
                if (orphans.length > 0) {
                    if (sync.deleteRemovedNotes) {
                        try {
                            await ankiInvoke(port, 'deleteNotes', { notes: orphans });
                            total.deleted += orphans.length;
                        }
                        catch (err) {
                            total.errors.push(`Deleting removed notes failed: ${err.message}`);
                        }
                    }
                    if (sync.deleteRemovedNotes ? total.deleted > 0 : true) {
                        orphans.forEach((id) => delete state.notes[id]);
                        await this.saveState();
                    }
                }
            }
            return total;
        });
    }

    onRename(oldPath: string, newPath: string) {
        const state = this.getState();
        let changed = false;
        Object.values(state.notes).forEach((n) => {
            if (n.file === oldPath) { n.file = newPath; changed = true; }
        });
        state.pending.forEach((p) => {
            if (p.file === oldPath) { p.file = newPath; changed = true; }
        });
        if (changed) this.saveState();
    }

    private async isFlashcardFile(file: TFile, tag: string) {
        const cache = this.app.metadataCache.getFileCache(file);
        if (tag && cache) {
            const tags = getAllTags(cache) ?? [];
            const wanted = `#${tag.replace(/^#/, '')}`.toLowerCase();
            if (tags.some((t) => t.toLowerCase() === wanted)) return true;
        }
        if (this.getState().pending.some((p) => p.file === file.path)) return true;
        return hasIdMarkers(await this.app.vault.cachedRead(file));
    }

    private parserOptions(): ParserOptions {
        const { sync } = this.getSettings();
        return {
            basicSeparator: sync.basicSeparator,
            reversedSeparator: sync.reversedSeparator,
            clozeHighlights: sync.clozeHighlights,
        };
    }

    private modelFor(type: CardType) {
        const { sync } = this.getSettings();
        if (type === 'cloze') return sync.clozeModel;
        if (type === 'reversed') return sync.reversedModel;
        return sync.basicModel;
    }

    private async fieldNames(model: string) {
        let names = this.fieldNameCache.get(model);
        if (!names) {
            names = await ankiInvoke<string[]>(this.getSettings().port, 'modelFieldNames', { modelName: model });
            if (!names || names.length < (model === this.getSettings().sync.clozeModel ? 1 : 2)) {
                throw new Error(`Anki note type "${model}" was not found or has too few fields`);
            }
            this.fieldNameCache.set(model, names);
        }
        return names;
    }

    // field that receives the extra text, or null to append it to the answer
    private extraFieldName(type: CardType, names: string[]) {
        if (type === 'cloze') return names[1] ?? null;
        const wanted = this.getSettings().sync.extraField;
        return names.slice(2).find((n) => n === wanted) ?? null;
    }

    private async buildFields(card: Pick<ParsedCard, 'type' | 'front' | 'back' | 'text' | 'extra' | 'deck' | 'tags'>, fileDeck: string) {
        const model = this.modelFor(card.type);
        const names = await this.fieldNames(model);
        const fields: Record<string, string> = {};
        const extraName = this.extraFieldName(card.type, names);
        const extraHtml = mdToHtml(card.extra);
        if (card.type === 'cloze') {
            fields[names[0]] = clozeMdToHtml(card.text);
        }
        else {
            fields[names[0]] = mdToHtml(card.front);
            fields[names[1]] = mdToHtml(card.back);
            if (!extraName && extraHtml) fields[names[1]] += EXTRA_DIVIDER + extraHtml;
        }
        if (extraName) fields[extraName] = extraHtml;
        const deck = card.deck ?? fileDeck;
        const tags = card.tags;
        const hashed: Record<string, string> = { ...fields, [DECK_KEY]: deck };
        if (tags) hashed[TAGS_KEY] = sortedTags(tags);
        return { model, fields, deck, tags, obsHash: hashFields(model, hashed) };
    }

    private cardFromAnki(card: ParsedCard, info: AnkiNoteInfo, names: string[]) {
        const values = ankiFieldValues(info);
        const extraName = this.extraFieldName(card.type, names);
        const extra = extraName ? htmlToMd(values[extraName] ?? '') : '';
        if (card.type === 'cloze') {
            return { ...card, text: clozeHtmlToMd(values[names[0]] ?? ''), extra };
        }
        const [back, appendedExtra = ''] = (values[names[1]] ?? '').split(EXTRA_DIVIDER_REGEX);
        return {
            ...card,
            front: htmlToMd(values[names[0]] ?? ''),
            back: htmlToMd(back),
            extra: extraName ? extra : htmlToMd(appendedExtra),
        };
    }

    private deckFor(file: TFile) {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const fromFm = fm?.['anki-deck'];
        if (typeof fromFm === 'string' && fromFm.trim()) return fromFm.trim();
        return this.getSettings().defaultDeck || 'Default';
    }

    // tags for a new note: plugin defaults + the note's anki-tags frontmatter + the line's own tags
    private tagsFor(cardTags: string[] | null, file: TFile) {
        const defaults = this.getSettings().sync.tags.split(/[\s,]+/).filter((t) => t.length > 0);
        const fmTags = this.app.metadataCache.getFileCache(file)?.frontmatter?.['anki-tags'];
        const noteTags = Array.isArray(fmTags) ? fmTags.map(String) : typeof fmTags === 'string' ? splitTags(fmTags) : [];
        return [...new Set([...defaults, ...noteTags, ...(cardTags ?? [])])];
    }

    // note info plus the deck of its first card
    private async ankiState(ids: number[]) {
        const port = this.getSettings().port;
        const infos = await notesInfo(port, ids);
        const firstCards = [...infos.values()].map((i) => i.cards[0]).filter((c) => c != null);
        const cards = firstCards.length > 0
            ? await ankiInvoke<{ cardId: number; deckName: string }[]>(port, 'cardsInfo', { cards: firstCards })
            : [];
        const deckByCard = new Map(cards.map((c) => [c.cardId, c.deckName]));
        const out = new Map<number, AnkiNoteState>();
        infos.forEach((info, id) => out.set(id, { info, deck: deckByCard.get(info.cards[0]) ?? '' }));
        return out;
    }

    private async syncFileUnlocked(file: TFile, range?: LineRange): Promise<SyncReport> {
        const report = emptyReport();
        try {
            await this.doSyncFile(file, range, report);
        }
        catch (err) {
            report.errors.push(err.message ?? String(err));
        }
        return report;
    }

    private async doSyncFile(file: TFile, range: LineRange | undefined, report: SyncReport) {
        const { port, sync } = this.getSettings();
        const opts = this.parserOptions();
        const state = this.getState();

        const content = await this.app.vault.read(file);
        let cards = parseCards(content, opts);
        if (range) cards = cards.filter((c) => c.line >= range.from && c.line <= range.to);
        if (cards.length === 0) return;

        const fileDeck = this.deckFor(file);

        const work: CardWork[] = [];
        const usedPending = new Set<number>();
        for (const card of cards) {
            const built = await this.buildFields(card, fileDeck);
            const w: CardWork = { card, ...built, id: card.id, needsMarker: false };
            if (w.id == null) {
                // recover an id that was created in Anki but never written to the file
                const pending = state.pending.find((p) => p.file === file.path && p.obsHash === w.obsHash && !usedPending.has(p.noteId));
                if (pending) {
                    usedPending.add(pending.noteId);
                    w.id = pending.noteId;
                    w.needsMarker = true;
                }
            }
            work.push(w);
        }

        for (const deck of new Set(work.map((w) => w.deck))) {
            await ankiInvoke(port, 'createDeck', { deck });
        }

        const anki = await this.ankiState(work.filter((w) => w.id != null).map((w) => w.id as number));

        const toAdd: CardWork[] = [];
        const toUpdate: { w: CardWork; current: AnkiNoteState }[] = [];
        const toPull: { w: CardWork; current: AnkiNoteState }[] = [];
        const inSync: { w: CardWork; current: AnkiNoteState }[] = [];

        for (const w of work) {
            const current = w.id != null ? anki.get(w.id) : undefined;
            if (w.id == null || !current) {
                // new card, or the note was deleted in Anki -> (re)create it
                if (w.id != null) {
                    const staleId = w.id;
                    delete state.notes[staleId];
                    state.pending = state.pending.filter((p) => p.noteId !== staleId);
                }
                w.id = null;
                toAdd.push(w);
                continue;
            }
            const { info } = current;
            // a synced line without {{deck::}} (older version, or field removed) keeps
            // the deck the card has in Anki instead of being moved back
            if (w.card.deck == null) {
                Object.assign(w, await this.buildFields(w.card, current.deck));
            }
            if (info.modelName !== w.model) {
                // card type changed (e.g. :: -> :::); notes can't change type in place
                w.replaces = w.id;
                w.id = null;
                toAdd.push(w);
                continue;
            }

            report.seenIds.add(w.id);
            const record = state.notes[w.id];
            const ankiValues = ankiFieldValues(info);
            const legacy = record != null && (record.v ?? 1) < RECORD_VERSION;


            const sameContent = Object.entries(w.fields).every(([k, v]) => ankiValues[k] === v)
                && w.deck === current.deck
                && (w.tags == null || sortedTags(w.tags) === sortedTags(info.tags));

            let side: 'none' | 'obsidian' | 'anki';
            if (sameContent) side = 'none';
            else if (!record) side = this.resolveConflict(sync.conflictPolicy, file, info);
            else {
                // older records hashed fields only (no deck/tags, no empty extra field)
                const nonEmpty = Object.fromEntries(Object.entries(w.fields).filter(([, v]) => v !== ''));
                const obsChanged = legacy
                    ? record.obsHash !== hashFields(w.model, nonEmpty)
                    : record.obsHash !== w.obsHash;
                const ankiChanged = legacy
                    ? record.ankiHash !== hashFields(info.modelName, ankiValues)
                    : record.ankiHash !== ankiHashOf(current);
                if (!obsChanged && !ankiChanged) side = 'none';
                else if (obsChanged && !ankiChanged) side = 'obsidian';
                else if (!obsChanged && ankiChanged) side = 'anki';
                else side = this.resolveConflict(sync.conflictPolicy, file, info);
            }

            if (legacy) report.upgraded++;
            if (side === 'obsidian') toUpdate.push({ w, current });
            else if (side === 'anki') toPull.push({ w, current });
            else { inSync.push({ w, current }); report.unchanged++; }
        }

        const toDelete: number[] = [];

        // 1. create new notes and journal their ids before touching the file
        const addTags = toAdd.map((w) => this.tagsFor(w.tags, file));
        const addResults = await ankiMulti<number>(port, toAdd.map((w, i) => ({
            action: 'addNote',
            params: {
                note: {
                    deckName: w.deck,
                    modelName: w.model,
                    fields: w.fields,
                    tags: addTags[i],
                    options: { allowDuplicate: false, duplicateScope: 'deck' },
                },
            },
        })));
        const added: { w: CardWork; tags: string[] }[] = [];
        addResults.forEach((r, i) => {
            const w = toAdd[i];
            if (r.error || r.result == null) {
                report.errors.push(`Could not add "${w.card.front || w.card.text}": ${r.error}`);
                return;
            }
            w.id = r.result;
            w.needsMarker = true;
            if (w.replaces != null) {
                toDelete.push(w.replaces);
                delete state.notes[w.replaces];
            }
            state.pending.push({ file: file.path, obsHash: w.obsHash, noteId: r.result });
            added.push({ w, tags: addTags[i] });
            report.added++;
            report.seenIds.add(r.result);
        });
        if (added.length > 0) await this.saveState();

        // 2. push Obsidian edits (fields, deck, tags) to Anki
        const updateActions: { action: string; params: object; idx: number }[] = [];
        toUpdate.forEach(({ w, current }, idx) => {
            const { info } = current;
            updateActions.push({ action: 'updateNoteFields', params: { note: { id: w.id, fields: w.fields } }, idx });
            if (w.deck !== current.deck) {
                updateActions.push({ action: 'changeDeck', params: { cards: info.cards, deck: w.deck }, idx });
            }
            if (w.tags) {
                const removed = info.tags.filter((t) => !w.tags?.includes(t));
                const addedTags = w.tags.filter((t) => !info.tags.includes(t));
                if (removed.length > 0) updateActions.push({ action: 'removeTags', params: { notes: [w.id], tags: removed.join(' ') }, idx });
                if (addedTags.length > 0) updateActions.push({ action: 'addTags', params: { notes: [w.id], tags: addedTags.join(' ') }, idx });
            }
        });
        const updateResults = await ankiMulti<null>(port, updateActions.map(({ action, params }) => ({ action, params })));
        const failedUpdates = new Set<number>();
        updateResults.forEach((r, i) => {
            if (!r.error) return;
            const { idx, action } = updateActions[i];
            failedUpdates.add(idx);
            report.errors.push(`Could not update note ${toUpdate[idx].w.id} (${action}): ${r.error}`);
        });
        const updated = toUpdate.filter((_, idx) => !failedUpdates.has(idx));
        report.updated += updated.length;

        if (toDelete.length > 0) {
            try { await ankiInvoke(port, 'deleteNotes', { notes: toDelete }); }
            catch (err) { report.errors.push(`Could not delete replaced notes: ${err.message}`); }
        }

        // 3. write ids, deck/tag fields and pulled Anki edits back into the file
        const edits: LineEdit[] = [];
        const recordAfterWrite: { id: number; obsHash: string }[] = [];
        const cr = (raw: string) => raw.endsWith('\r');

        const finalLines: { w: CardWork; newLine: string; pulled: boolean }[] = [];
        added.forEach(({ w, tags }) => finalLines.push({ w, newLine: setMetaOnLine(w.card.raw, w.id as number, w.deck, tags), pulled: false }));
        updated.forEach(({ w, current }) => finalLines.push({
            w, newLine: setMetaOnLine(w.card.raw, w.id as number, w.deck, w.tags ?? current.info.tags), pulled: false,
        }));
        inSync.forEach(({ w, current }) => finalLines.push({
            w, newLine: setMetaOnLine(w.card.raw, w.id as number, current.deck, current.info.tags), pulled: false,
        }));
        for (const { w, current } of toPull) {
            const names = await this.fieldNames(current.info.modelName);
            const pulled = { ...this.cardFromAnki(w.card, current.info, names), deck: current.deck, tags: current.info.tags };
            finalLines.push({ w, newLine: formatCardLine(pulled, opts, w.id as number, cr(w.card.raw)), pulled: true });
        }

        for (const { w, newLine, pulled } of finalLines) {
            const id = w.id as number;
            const record = state.notes[id];
            if (newLine === w.card.raw) {
                const stale = !record || (record.v ?? 1) < RECORD_VERSION || record.obsHash !== w.obsHash || record.file !== file.path;
                if (stale || updated.some((u) => u.w === w)) {
                    recordAfterWrite.push({ id, obsHash: w.obsHash });
                }
                continue;
            }
            const reparsed = parseCardLine(newLine, w.card.line, opts);
            if (!reparsed) {
                report.errors.push(`Anki note ${id} could not be written back (empty field?)`);
                continue;
            }
            const { obsHash } = await this.buildFields(reparsed, fileDeck);
            edits.push({
                line: w.card.line,
                raw: w.card.raw,
                newLine,
                onApplied: () => {
                    state.pending = state.pending.filter((p) => p.noteId !== id);
                    recordAfterWrite.push({ id, obsHash });
                    if (pulled) report.pulled++;
                },
            });
        }

        if (edits.length > 0) {
            let skipped = 0;
            await this.app.vault.process(file, (data) => {
                const lines = data.split('\n');
                const applied: (() => void)[] = [];
                skipped = 0;
                for (const e of edits) {
                    let idx = lines[e.line] === e.raw ? e.line : -1;
                    if (idx < 0) {
                        // the file changed since we read it: relocate by exact content
                        const first = lines.indexOf(e.raw);
                        if (first >= 0 && lines.indexOf(e.raw, first + 1) < 0) idx = first;
                    }
                    if (idx < 0) { skipped++; continue; }
                    lines[idx] = e.newLine;
                    applied.push(e.onApplied);
                }
                applied.forEach((fn) => fn());
                return lines.join('\n');
            });
            if (skipped > 0) {
                report.errors.push(`${skipped} card line(s) changed during sync; they will be finished on the next sync`);
            }
        }

        // 4. record what Anki actually stores now (Anki may normalise HTML)
        const after = await this.ankiState(recordAfterWrite.map((r) => r.id));
        recordAfterWrite.forEach(({ id, obsHash }) => {
            const current = after.get(id);
            if (!current) return;
            state.notes[id] = { file: file.path, obsHash, ankiHash: ankiHashOf(current), v: RECORD_VERSION };
        });
        await this.saveState();
    }

    private resolveConflict(policy: SyncSettings['conflictPolicy'], file: TFile, info: AnkiNoteInfo): 'obsidian' | 'anki' {
        if (policy === 'obsidian' || policy === 'anki') return policy;
        // newest wins; Anki's mod is in seconds, file mtime in ms
        if (info.mod == null) return 'obsidian';
        return file.stat.mtime >= info.mod * 1000 ? 'obsidian' : 'anki';
    }
}
