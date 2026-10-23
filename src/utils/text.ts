// Shrinks a note before it is sent to an AI model, to save input tokens.
// Drops content that carries no study material (frontmatter, embeds, URLs, sync markers).
export function compactNotes(notes: string) {
    return notes
        .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/%%[\s\S]*?%%/g, '')
        .replace(/!\[\[[^\]]*\]\]/g, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export interface TextHeading {
    heading: string;
    level: number;
    line: number;
}

// headings read from the live text (the metadata cache lags behind unsaved edits)
export function parseHeadings(text: string): TextHeading[] {
    const lines = text.split('\n');
    const out: TextHeading[] = [];
    let i = 0;
    if (lines[0]?.replace(/\r$/, '') === '---') {
        i = 1;
        while (i < lines.length && lines[i].replace(/\r$/, '') !== '---') i++;
        i++;
    }
    let inFence = false;
    for (; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, '');
        if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
        if (inFence) continue;
        const m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
        if (m && m[2]) out.push({ heading: m[2], level: m[1].length, line: i });
    }
    return out;
}

// lines of the given heading sections; a section runs to the next heading of the same or higher level
export function sectionLines(headings: TextHeading[], picked: TextHeading[], totalLines: number) {
    const include = new Set<number>();
    for (const h of picked) {
        const next = headings.find((o) => o.line > h.line && o.level <= h.level);
        const end = next ? next.line : totalLines;
        for (let i = h.line; i < end; i++) include.add(i);
    }
    return include;
}
