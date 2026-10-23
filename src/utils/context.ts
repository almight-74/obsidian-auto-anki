import { App, TFile } from 'obsidian';

import { compactNotes } from './text';

// a note (or one heading of it) linked with [[wiki link]], usable as AI context
export interface LinkedNote {
    file: TFile;
    heading: string | null;
    label: string;
}

export interface ContextNote {
    title: string;
    text: string;
}

const LINK_REGEX = /!?\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g;

function resolve(app: App, target: string, sourcePath: string): LinkedNote | null {
    const [path, sub] = target.split('#');
    const file = app.metadataCache.getFirstLinkpathDest(path.trim(), sourcePath);
    if (!file || file.extension !== 'md') return null;
    // block references (#^id) fall back to the whole note
    const heading = sub && !sub.startsWith('^') ? sub.trim() : null;
    return { file, heading, label: heading ? `${file.basename} › ${heading}` : file.basename };
}

function dedupe(notes: LinkedNote[], sourcePath: string) {
    const seen = new Set<string>();
    return notes.filter((n) => {
        const key = `${n.file.path}#${n.heading ?? ''}`;
        if (n.file.path === sourcePath && !n.heading) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function findLinkedNotes(app: App, text: string, sourcePath: string) {
    const found: LinkedNote[] = [];
    for (const m of text.matchAll(LINK_REGEX)) {
        const n = resolve(app, m[1], sourcePath);
        if (n) found.push(n);
    }
    return dedupe(found, sourcePath);
}

// accepts [[links]] or plain note names separated by commas / new lines
export function parseNoteInput(app: App, input: string, sourcePath: string) {
    if (input.includes('[[')) return findLinkedNotes(app, input, sourcePath);
    const found = input.split(/[,\n]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => resolve(app, s, sourcePath))
        .filter((n): n is LinkedNote => n != null);
    return dedupe(found, sourcePath);
}

function headingSection(app: App, file: TFile, content: string, heading: string) {
    const headings = app.metadataCache.getFileCache(file)?.headings ?? [];
    const h = headings.find((x) => x.heading.trim().toLowerCase() === heading.toLowerCase());
    if (!h) return content;
    const next = headings.find((x) => x.position.start.line > h.position.start.line && x.level <= h.level);
    const lines = content.split('\n');
    return lines.slice(h.position.start.line, next ? next.position.start.line : lines.length).join('\n');
}

// reads linked notes, compacted and capped so context can't blow up token use
export async function loadContextNotes(app: App, notes: LinkedNote[], perNoteChars = 6000, totalChars = 24000) {
    const out: ContextNote[] = [];
    let used = 0;
    for (const n of notes) {
        if (used >= totalChars) break;
        const raw = await app.vault.cachedRead(n.file);
        let text = compactNotes(n.heading ? headingSection(app, n.file, raw, n.heading) : raw);
        const limit = Math.min(perNoteChars, totalChars - used);
        if (text.length > limit) text = `${text.slice(0, limit)}…`;
        if (text.length === 0) continue;
        out.push({ title: n.label, text });
        used += text.length;
    }
    return out;
}

export function contextBlock(notes: ContextNote[]) {
    return notes
        .map((n) => `<context_note title="${n.title.replace(/"/g, "'")}">\n${n.text}\n</context_note>`)
        .join('\n');
}
