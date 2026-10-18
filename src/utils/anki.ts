import { Notice, requestUrl } from 'obsidian';

import { CardInformation } from './gpt';

const ANKI_VERSION = 6;
// const ANKI_DEFAULT_DECK = 'Default';
export const ANKI_CONNECT_DEFAULT_PORT = 8765;

export async function checkAnkiAvailability(ankiPort: number) {
    try {
        await requestUrl({
            method: 'POST',
            url: `http://127.0.0.1:${ankiPort}`,
            body: JSON.stringify({
                action: 'deckNames',
                version: ANKI_VERSION,
                params: {},
            }),
            throw: true,
        });
        return true;
    }
    catch (err) {
        new Notice(`ERR: Could not connect to Anki! Please ensure you have Anki Connect running on port ${ankiPort}.`);
        return false;
    }
}

async function addCardsToAnki(ankiPort: number, deck: string, data: CardInformation[]) {
    // for anki connect, the request format is (https://foosoft.net/projects/anki-connect/)
    const ankiRequestData = data.map((card) => ({
        'deckName': deck,
        'modelName': 'Basic',
        'fields': {
            'Front': card.q,
            'Back': card.a,
        },
        'tags': [
            'auto-gpt-imported'
        ],
    }));
    try {
        const res = await requestUrl({
            method: 'POST',
            url: `http://127.0.0.1:${ankiPort}`,
            body: JSON.stringify({
                action: 'addNotes',
                version: ANKI_VERSION,
                params: {
                    'notes': ankiRequestData,
                }
        }),
            throw: true,
        });
        return res.json.result ?? [];
    }
    catch (err) {
        new Notice(`ERR: Could not connect to Anki! Please ensure you have Anki Connect running on port ${ankiPort}.`);
        return [];
    }
}

export async function getAnkiDecks(ankiPort: number) {
    let res;
    try {
        res = await requestUrl({
            method: 'POST',
            url: `http://127.0.0.1:${ankiPort}`,
            body: JSON.stringify({
                action: 'deckNames',
                version: ANKI_VERSION,
                params: {},
            }),
            throw: true,
        });
    }
    catch (err) {
        new Notice(`ERR: Could not connect to Anki! Please ensure you have Anki Connect running on port ${ankiPort}.`);
        return [];
    }
    return res.json.result as string[];
}

export async function checkAnkiDecksExist(ankiPort: number) {
    const decks = await getAnkiDecks(ankiPort);
    if (decks.length == 0) {
        new Notice('Your anki account has no decks. Create a new one before using!')
        return false;
    }

    return true;
}

export async function exportToAnki(cards: CardInformation[], port: number, deck: string) {
    // turn note into Q&A format using GPT
    const ankiRes: number[] = await addCardsToAnki(port, deck, cards);
    if (ankiRes.length > 0) new Notice(`Successfully exported ${ankiRes.length} card(s) to Anki!`)
    return true;
}

export class AnkiConnectError extends Error {}
export class AnkiUnreachableError extends AnkiConnectError {}

export interface AnkiNoteInfo {
    noteId: number;
    modelName: string;
    tags: string[];
    fields: Record<string, { value: string; order: number }>;
    mod?: number;
    cards: number[];
}

export interface AnkiNewNote {
    deckName: string;
    modelName: string;
    fields: Record<string, string>;
    tags: string[];
    options?: { allowDuplicate?: boolean; duplicateScope?: string };
}

export async function ankiInvoke<T>(port: number, action: string, params: object = {}): Promise<T> {
    let res;
    try {
        res = await requestUrl({
            method: 'POST',
            url: `http://127.0.0.1:${port}`,
            body: JSON.stringify({ action, version: ANKI_VERSION, params }),
            throw: true,
        });
    }
    catch (err) {
        throw new AnkiUnreachableError(`Could not connect to Anki Connect on port ${port}. Is Anki running?`);
    }
    if (res.json.error) throw new AnkiConnectError(`${action}: ${res.json.error}`);
    return res.json.result as T;
}

// runs several actions in one request; each entry gets its own result or error
export async function ankiMulti<T>(port: number, actions: { action: string; params: object }[]) {
    if (actions.length === 0) return [];
    const results = await ankiInvoke<{ result: T | null; error: string | null }[]>(port, 'multi', {
        actions: actions.map((a) => ({ ...a, version: ANKI_VERSION })),
    });
    return results;
}

export async function notesInfo(port: number, ids: number[]) {
    if (ids.length === 0) return new Map<number, AnkiNoteInfo>();
    let infos: (AnkiNoteInfo | Record<string, never>)[];
    try {
        infos = await ankiInvoke(port, 'notesInfo', { notes: ids });
    }
    catch (err) {
        // some Anki Connect versions error out on deleted notes instead of returning {}
        if (err instanceof AnkiUnreachableError) throw err;
        const existing = await ankiInvoke<number[]>(port, 'findNotes', { query: `nid:${ids.join(',')}` });
        infos = existing.length > 0 ? await ankiInvoke(port, 'notesInfo', { notes: existing }) : [];
    }
    const map = new Map<number, AnkiNoteInfo>();
    infos.forEach((info) => {
        if (info && 'noteId' in info) map.set(info.noteId, info as AnkiNoteInfo);
    });
    return map;
}
