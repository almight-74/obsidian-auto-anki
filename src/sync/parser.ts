// Parses inline flashcard syntax out of a markdown note.
//   Front::Back          -> basic card
//   Front:::Back         -> basic + reversed card
//   text with ==cloze==  -> cloze card (one cloze deletion per highlight)
// Optional inline fields on any card line:
//   {{extra::text}}  {{deck::Deck::Sub}}  {{tag::tag1 tag2}}
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
    extra: string;          // {{extra::}}, all types
    deck: string | null;    // {{deck::}}, null = note / default deck
    tags: string[] | null;  // {{tag::}}, null = not specified on the line
    id: number | null;
}

const ID_MARKER_REGEX = /\s*<!--\s*anki:(\d+)\s*-->\s*$/;
const PREFIX_REGEX = /^(\s*(?:>\s*)*(?:[-*+]\s+(?:\[.\]\s+)?|\d+[.)]\s+)?)/;
const FENCE_REGEX = /^\s*(```|~~~)/;
const HIGHLIGHT_REGEX = /==[^=\n]+?==/;
const ANKI_CLOZE_REGEX = /\{\{c\d+::/;
// {{deck::...}}, {{tag::...}} / {{tags::...}}, {{extra::...}}; value can't contain "}}"
const FIELD_REGEX = /\s*\{\{(deck|tags?|extra)::((?:(?!\}\}).)*)\}\}/gi;
const META_FIELD_REGEX = /\s*\{\{(deck|tags?)::((?:(?!\}\}).)*)\}\}/gi;

export function splitTags(value: string) {
    return value.split(/[\s,]+/).filter((t) => t.length > 0);
}

function escapeFieldValue(value: string) {
    return value.replace(/\}\}/g, '} }').replace(/\r?\n/g, '<br>');
}

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
    let extra = '';
    let deck: string | null = null;
    let tags: string[] | null = null;
    const content = body.slice(prefix.length).replace(FIELD_REGEX, (_, key: string, value: string) => {
        const k = key.toLowerCase();
        if (k === 'extra') extra = value.trim();
        else if (k === 'deck') deck = value.trim() || null;
        else tags = [...(tags ?? []), ...splitTags(value)];
        return '';
    });
    if (content.trim().length === 0) return null;

    const base = { line: lineIdx, raw, prefix, id, front: '', back: '', text: '', extra, deck, tags };

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

function formatMeta(deck: string | null, tags: string[] | null) {
    let out = '';
    if (deck) out += ` {{deck::${escapeFieldValue(deck)}}}`;
    if (tags && tags.length > 0) out += ` {{tag::${tags.join(' ')}}}`;
    return out;
}

export function formatCardLine(
    card: Pick<ParsedCard, 'prefix' | 'type' | 'front' | 'back' | 'text' | 'extra' | 'deck' | 'tags'>,
    opts: ParserOptions,
    id: number | null,
    keepCarriageReturn = false,
) {
    let body: string;
    if (card.type === 'cloze') body = card.text;
    else if (card.type === 'reversed') body = `${card.front}${opts.reversedSeparator}${card.back}`;
    else body = `${card.front}${opts.basicSeparator}${card.back}`;
    if (card.extra) body += ` {{extra::${escapeFieldValue(card.extra)}}}`;
    body += formatMeta(card.deck, card.tags);

    const marker = id != null ? ` ${formatIdMarker(id)}` : '';
    return `${card.prefix}${body}${marker}${keepCarriageReturn ? '\r' : ''}`;
}

// rewrites only the deck/tag fields and id marker, leaving the user's text as written
export function setMetaOnLine(raw: string, id: number, deck: string | null, tags: string[] | null) {
    const cr = raw.endsWith('\r');
    const line = raw
        .replace(/\r$/, '')
        .replace(ID_MARKER_REGEX, '')
        .replace(META_FIELD_REGEX, '')
        .replace(/\s+$/, '');
    return `${line}${formatMeta(deck, tags)} ${formatIdMarker(id)}${cr ? '\r' : ''}`;
}

export function hasIdMarkers(content: string) {
    return /<!--\s*anki:\d+\s*-->/.test(content);
}
