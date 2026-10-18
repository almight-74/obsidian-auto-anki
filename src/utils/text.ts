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
