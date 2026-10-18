// Markdown <-> Anki field HTML conversion. Kept intentionally small so that
// round-trips (Obsidian -> Anki -> Obsidian) are stable for common formatting.

function escapeHtml(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeEntities(s: string) {
    return s
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&amp;/g, '&');
}

export function mdToHtml(md: string) {
    const slots: string[] = [];
    const stash = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;

    let s = md
        .replace(/`([^`]+)`/g, (_, c) => stash(`<code>${escapeHtml(c)}</code>`))
        .replace(/\$\$([^$]+)\$\$/g, (_, m) => stash(`\\[${escapeHtml(m)}\\]`))
        .replace(/\$([^$\s][^$]*?)\$/g, (_, m) => stash(`\\(${escapeHtml(m)}\\)`))
        .replace(/<br\s*\/?>/gi, () => stash('<br>'));

    s = escapeHtml(s)
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/\*(.+?)\*/g, '<i>$1</i>');

    // eslint-disable-next-line no-control-regex
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

export function htmlToMd(html: string) {
    const s = html
        .replace(/\r?\n/g, '<br>')
        .replace(/<br\s*\/?>/gi, '\u0001')
        .replace(/<div[^>]*>/gi, '\u0001')
        .replace(/<\/div>/gi, '')
        .replace(/<\/?(b|strong)(\s[^>]*)?>/gi, '**')
        .replace(/<\/?(i|em)(\s[^>]*)?>/gi, '*')
        .replace(/<\/?code(\s[^>]*)?>/gi, '`')
        .replace(/\\\((.+?)\\\)/g, '$$$1$$')
        .replace(/\\\[(.+?)\\\]/g, '$$$$$1$$$$')
        .replace(/<[^>]+>/g, '');

    return decodeEntities(s)
        // eslint-disable-next-line no-control-regex
        .replace(/^\u0001+|\u0001+$/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/\u0001/g, '<br>')
        .trim();
}

export function clozeMdToHtml(md: string) {
    let n = 0;
    return mdToHtml(md).replace(/==(.+?)==/g, (_, c) => `{{c${++n}::${c}}}`);
}

export function clozeHtmlToMd(html: string) {
    return htmlToMd(html).replace(/\{\{c\d+::(.*?)(?:::[^}]*)?\}\}/g, '==$1==');
}

// FNV-1a, used for change detection only
export function hashString(s: string) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}

export function hashFields(model: string, fields: Record<string, string>) {
    const ordered = Object.keys(fields).sort().map((k) => [k, fields[k]]);
    return hashString(JSON.stringify([model, ordered]));
}
