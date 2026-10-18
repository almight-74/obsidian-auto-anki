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
    setIdOnLine,
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

function emptyReport(): SyncReport {
    return { added: 0, updated: 0, pulled: 0, deleted: 0, unchanged: 0, errors: [], seenIds: new Set() };
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

    private async buildFields(card: Pick<ParsedCard, 'type' | 'front' | 'back' | 'text'>) {
        const model = this.modelFor(card.type);
        const names = await this.fieldNames(model);
        const fields: Record<string, string> = {};
        if (card.type === 'cloze') {
            fields[names[0]] = clozeMdToHtml(card.text);
        }
        else {
            fields[names[0]] = mdToHtml(card.front);
            fields[names[1]] = mdToHtml(card.back);
        }
        return { model, fields, obsHash: hashFields(model, fields) };
    }

    private cardFromAnki(card: ParsedCard, info: AnkiNoteInfo, names: string[]) {
        const values = ankiFieldValues(info);
        if (card.type === 'cloze') {
            return { ...card, text: clozeHtmlToMd(values[names[0]] ?? '') };
        }
        return { ...card, front: htmlToMd(values[names[0]] ?? ''), back: htmlToMd(values[names[1]] ?? '') };
    }

    private deckFor(file: TFile) {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const fromFm = fm?.['anki-deck'];
        if (typeof fromFm === 'string' && fromFm.trim()) return fromFm.trim();
        return this.getSettings().defaultDeck || 'Default';
    }

    private tagsFor() {
        return this.getSettings().sync.tags.split(/[\s,]+/).filter((t) => t.length > 0);
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

        const deck = this.deckFor(file);
        await ankiInvoke(port, 'createDeck', { deck });

        const work: CardWork[] = [];
        const usedPending = new Set<number>();
        for (const card of cards) {
            const built = await this.buildFields(card);
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

        const infos = await notesInfo(port, work.filter((w) => w.id != null).map((w) => w.id as number));

        const toAdd: CardWork[] = [];
        const toUpdate: CardWork[] = [];
        const toPull: { w: CardWork; info: AnkiNoteInfo }[] = [];
        const toRecord: CardWork[] = [];

        for (const w of work) {
            const info = w.id != null ? infos.get(w.id) : undefined;
            if (w.id == null || !info) {
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
            const ankiHash = hashFields(info.modelName, ankiValues);
            const sameContent = Object.entries(w.fields).every(([k, v]) => ankiValues[k] === v);

            if (!record) {
                // no history (recovered id or lost state): only content tells us anything
                if (sameContent) toRecord.push(w);
                else if (this.resolveConflict(sync.conflictPolicy, file, info) === 'obsidian') toUpdate.push(w);
                else toPull.push({ w, info });
                continue;
            }

            const obsChanged = record.obsHash !== w.obsHash;
            const ankiChanged = record.ankiHash !== ankiHash;

            if ((!obsChanged && !ankiChanged) || sameContent) {
                report.unchanged++;
                const stale = obsChanged || ankiChanged || record.file !== file.path;
                if (w.needsMarker || stale) toRecord.push(w);
            }
            else if (obsChanged && !ankiChanged) toUpdate.push(w);
            else if (!obsChanged && ankiChanged) toPull.push({ w, info });
            else if (this.resolveConflict(sync.conflictPolicy, file, info) === 'obsidian') toUpdate.push(w);
            else toPull.push({ w, info });
        }

        const toDelete: number[] = [];

        // 1. create new notes and journal their ids before touching the file
        const addResults = await ankiMulti<number>(port, toAdd.map((w) => ({
            action: 'addNote',
            params: {
                note: {
                    deckName: deck,
                    modelName: w.model,
                    fields: w.fields,
                    tags: this.tagsFor(),
                    options: { allowDuplicate: false, duplicateScope: 'deck' },
                },
            },
        })));
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
            report.added++;
            report.seenIds.add(r.result);
        });
        if (toAdd.length > 0) await this.saveState();

        // 2. push Obsidian edits to Anki
        const updateResults = await ankiMulti<null>(port, toUpdate.map((w) => ({
            action: 'updateNoteFields',
            params: { note: { id: w.id, fields: w.fields } },
        })));
        const updatedOk: CardWork[] = [];
        updateResults.forEach((r, i) => {
            if (r.error) report.errors.push(`Could not update note ${toUpdate[i].id}: ${r.error}`);
            else { updatedOk.push(toUpdate[i]); report.updated++; }
        });

        if (toDelete.length > 0) {
            try { await ankiInvoke(port, 'deleteNotes', { notes: toDelete }); }
            catch (err) { report.errors.push(`Could not delete replaced notes: ${err.message}`); }
        }

        // 3. write ids / pulled Anki edits back into the file
        const edits: LineEdit[] = [];
        const recordAfterWrite: { id: number; obsHash: string }[] = [];
        const cr = (raw: string) => raw.endsWith('\r');

        for (const w of [...toAdd, ...toRecord, ...updatedOk]) {
            if (w.id == null) continue;
            const id = w.id;
            if (!w.needsMarker) {
                recordAfterWrite.push({ id, obsHash: w.obsHash });
                continue;
            }
            edits.push({
                line: w.card.line,
                raw: w.card.raw,
                newLine: setIdOnLine(w.card.raw, id),
                onApplied: () => {
                    state.pending = state.pending.filter((p) => p.noteId !== id);
                    recordAfterWrite.push({ id, obsHash: w.obsHash });
                },
            });
        }

        for (const { w, info } of toPull) {
            const id = w.id as number;
            const names = await this.fieldNames(info.modelName);
            const pulled = this.cardFromAnki(w.card, info, names);
            const newLine = formatCardLine(pulled, opts, id, cr(w.card.raw));
            const reparsed = parseCardLine(newLine, w.card.line, opts);
            if (!reparsed) {
                report.errors.push(`Anki note ${id} could not be written back (empty field?)`);
                continue;
            }
            const { obsHash } = await this.buildFields(reparsed);
            edits.push({
                line: w.card.line,
                raw: w.card.raw,
                newLine,
                onApplied: () => {
                    state.pending = state.pending.filter((p) => p.noteId !== id);
                    recordAfterWrite.push({ id, obsHash });
                    report.pulled++;
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
        const after = await notesInfo(port, recordAfterWrite.map((r) => r.id));
        recordAfterWrite.forEach(({ id, obsHash }) => {
            const info = after.get(id);
            if (!info) return;
            state.notes[id] = {
                file: file.path,
                obsHash,
                ankiHash: hashFields(info.modelName, ankiFieldValues(info)),
            };
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
