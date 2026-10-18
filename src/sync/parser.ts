// Parses inline flashcard syntax out of a markdown note.
//   Front::Back          -> basic card
//   Front:::Back         -> basic + reversed card
//   text with ==cloze==  -> cloze card (one cloze deletion per highlight)
// Each synced card carries its Anki note id at the end of the line: <!--anki:123-->

export type CardType = 'basic' | 'reversed' | 'cloze';

export interface ParserOptions {
    basicSeparator: string;
    reversedSeparator: string;
    clozeHighlights: boolean;
}

export interface ParsedCard {
    line: number;      // 0-based line index in the file
    raw: string;       // full original line, used to relocate the card when writing back
    prefix: string;    // list / quote prefix kept when rewriting the line
    type: CardType;
    front: string;     // basic/reversed only
    back: string;      // basic/reversed only
    text: string;      // cloze only
    id: number | null;
}

const ID_MARKER_REGEX = /\s*<!--\s*anki:(\d+)\s*-->\s*$/;
const PREFIX_REGEX = /^(\s*(?:>\s*)*(?:[-*+]\s+(?:\[.\]\s+)?|\d+[.)]\s+)?)/;
const FENCE_REGEX = /^\s*(```|~~~)/;
const HIGHLIGHT_REGEX = /==[^=\n]+?==/;
const ANKI_CLOZE_REGEX = /\{\{c\d+::/;

export function formatIdMarker(id: number) {
    return `<!--anki:${id}-->`;
}

// index of the separator, ignoring occurrences inside `inline code`
function findSeparator(text: string, sep: string) {
    let inCode = false;
    for (let i = 0; i <= text.length - sep.length; i++) {
        if (text[i] === '`') inCode = !inCode;
        if (!inCode && text.startsWith(sep, i)) return i;
    }
    return -1;
}

export function parseCardLine(raw: string, lineIdx: number, opts: ParserOptions): ParsedCard | null {
    const line = raw.replace(/\r$/, '');
    let id: number | null = null;
    const idMatch = line.match(ID_MARKER_REGEX);
    let body = line;
    if (idMatch) {
        id = Number(idMatch[1]);
        body = line.slice(0, idMatch.index);
    }

    const prefix = (body.match(PREFIX_REGEX) ?? [''])[0];
    const content = body.slice(prefix.length);
    if (content.trim().length === 0) return null;

    const base = { line: lineIdx, raw, prefix, id, front: '', back: '', text: '' };

    const revIdx = findSeparator(content, opts.reversedSeparator);
    if (revIdx >= 0) {
        const front = content.slice(0, revIdx).trim();
        const back = content.slice(revIdx + opts.reversedSeparator.length).trim();
        if (front && back) return { ...base, type: 'reversed', front, back };
    }

    const basicIdx = findSeparator(content, opts.basicSeparator);
    // a reversed separator also contains the basic one, so skip if it matched above
    if (basicIdx >= 0 && basicIdx !== revIdx) {
        const front = content.slice(0, basicIdx).trim();
        const back = content.slice(basicIdx + opts.basicSeparator.length).trim();
        if (front && back) return { ...base, type: 'basic', front, back };
    }

    if (opts.clozeHighlights && (HIGHLIGHT_REGEX.test(content) || ANKI_CLOZE_REGEX.test(content))) {
        return { ...base, type: 'cloze', text: content.trim() };
    }

    return null;
}

export function parseCards(content: string, opts: ParserOptions): ParsedCard[] {
    const lines = content.split('\n');
    const cards: ParsedCard[] = [];
    let i = 0;

    // skip frontmatter
    if (lines[0]?.replace(/\r$/, '') === '---') {
        i = 1;
        while (i < lines.length && lines[i].replace(/\r$/, '') !== '---') i++;
        i++;
    }

    let inFence = false;
    let inMathBlock = false;
    for (; i < lines.length; i++) {
        const line = lines[i];
        if (FENCE_REGEX.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (line.trim() === '$$') {
            inMathBlock = !inMathBlock;
            continue;
        }
        if (inFence || inMathBlock) continue;

        const card = parseCardLine(line, i, opts);
        if (card) cards.push(card);
    }
    return cards;
}

export function formatCardLine(
    card: Pick<ParsedCard, 'prefix' | 'type' | 'front' | 'back' | 'text'>,
    opts: ParserOptions,
    id: number | null,
    keepCarriageReturn = false,
) {
    let body: string;
    if (card.type === 'cloze') body = card.text;
    else if (card.type === 'reversed') body = `${card.front}${opts.reversedSeparator}${card.back}`;
    else body = `${card.front}${opts.basicSeparator}${card.back}`;

    const marker = id != null ? ` ${formatIdMarker(id)}` : '';
    return `${card.prefix}${body}${marker}${keepCarriageReturn ? '\r' : ''}`;
}

export function setIdOnLine(raw: string, id: number) {
    const cr = raw.endsWith('\r');
    const line = raw.replace(/\r$/, '').replace(ID_MARKER_REGEX, '');
    return `${line} ${formatIdMarker(id)}${cr ? '\r' : ''}`;
}

export function hasIdMarkers(content: string) {
    return /<!--\s*anki:\d+\s*-->/.test(content);
}
