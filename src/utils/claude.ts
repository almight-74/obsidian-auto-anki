import Anthropic from '@anthropic-ai/sdk';

import logger from 'src/logger';
import { CardInformation } from './gpt';

const CARDS_SCHEMA = {
    type: 'object',
    properties: {
        cards: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    q: { type: 'string' },
                    a: { type: 'string' },
                },
                required: ['q', 'a'],
                additionalProperties: false,
            },
        },
    },
    required: ['cards'],
    additionalProperties: false,
};

function systemPrompt(numQuestions: number) {
    return `You write spaced-repetition flashcards from markdown notes.
Write exactly ${numQuestions} question/answer cards that together cover the whole of the given notes.
- One fact or idea per card; no duplicate or overlapping questions.
- Questions must make sense without seeing the notes.
- Answers should be short (a phrase or one sentence).
- Keep each question and answer on a single line. Markdown bold, italics, inline code and $math$ are allowed.`;
}

async function generateOneSet(client: Anthropic, model: string, notes: string, numQuestions: number) {
    const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: systemPrompt(numQuestions),
        messages: [{ role: 'user', content: notes.trim() }],
        output_config: { format: { type: 'json_schema', schema: CARDS_SCHEMA } },
    });

    if (response.stop_reason === 'refusal') {
        throw new Error('Claude declined to generate cards for this text.');
    }
    if (response.stop_reason === 'max_tokens') {
        throw new Error('Response was cut off; try fewer questions or a shorter selection.');
    }

    const text = response.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('');
    const parsed = JSON.parse(text) as { cards: CardInformation[] };
    return parsed.cards;
}

export async function convertNotesToFlashcardsWithClaude(
    apiKey: string,
    model: string,
    notes: string,
    numQuestions: number,
    numSets: number,
): Promise<CardInformation[][]> {
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    try {
        // Claude has no `n` parameter, so alternatives are separate parallel requests
        return await Promise.all(
            Array.from({ length: numSets }, () => generateOneSet(client, model, notes, numQuestions)),
        );
    }
    catch (err) {
        let message = err.message ?? String(err);
        if (err instanceof Anthropic.AuthenticationError) message = 'Check that your Anthropic API key is correct/valid!';
        else if (err instanceof Anthropic.RateLimitError) message = 'Rate limited by the Anthropic API, try again shortly.';
        else if (err instanceof Anthropic.APIError) message = `(${err.status}) ${err.message}`;
        logger.log({ level: 'error', message: `Could not generate cards with Claude! ${message}` });
        return [];
    }
}
