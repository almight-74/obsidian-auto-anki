import Anthropic from '@anthropic-ai/sdk';

import logger from 'src/logger';
import { GenerationOptions } from 'src/settings';
import { CardInformation } from './gpt';

const DIFFICULTY: Record<GenerationOptions['difficulty'], string> = {
    'easy': 'easy: recall of key terms, names and definitions',
    'medium': 'medium: understanding of concepts and how they relate',
    'hard': 'hard: application, comparison, edge cases; answering needs reasoning',
};

const CONCISENESS: Record<GenerationOptions['conciseness'], string> = {
    'very-concise': 'answers of a few words, no full sentences',
    'concise': 'answers of at most one short sentence',
    'detailed': 'answers of 1-3 sentences including the key reasoning',
};

function cardsSchema(extra: boolean) {
    const card = {
        type: 'object',
        properties: {
            q: { type: 'string' },
            a: { type: 'string' },
            ...(extra ? { extra: { type: 'string' } } : {}),
        },
        required: extra ? ['q', 'a', 'extra'] : ['q', 'a'],
        additionalProperties: false,
    };
    return {
        type: 'object',
        properties: {
            questions: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: { variants: { type: 'array', items: card } },
                    required: ['variants'],
                    additionalProperties: false,
                },
            },
        },
        required: ['questions'],
        additionalProperties: false,
    };
}

function systemPrompt(numQuestions: number, numVariants: number, opts: GenerationOptions) {
    const variants = numVariants > 1
        ? `Give each question ${numVariants} variants: different phrasings testing the same fact.`
        : 'Give each question exactly 1 variant.';
    const lines = [
        `Write ${numQuestions} spaced-repetition flashcards covering the user's notes. ${variants}`,
        `Difficulty ${DIFFICULTY[opts.difficulty]}.`,
        `Use ${CONCISENESS[opts.conciseness]}.`,
        'One fact per card, no overlapping cards, questions understandable without the notes. Single-line text; markdown **bold**, *italic*, `code`, $math$ allowed.',
    ];
    if (opts.extra) lines.push('extra: one short line of context, explanation or mnemonic that helps remember the answer.');
    return lines.join('\n');
}

export async function convertNotesToFlashcardsWithClaude(
    apiKey: string,
    model: string,
    notes: string,
    numQuestions: number,
    numSets: number,
    opts: GenerationOptions,
): Promise<CardInformation[][]> {
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    try {
        // one request for all variants so the notes are only sent (and billed) once
        const perCard = (opts.conciseness === 'detailed' ? 120 : 60) + (opts.extra ? 50 : 0);
        const response = await client.beta.messages.create({
            model,
            max_tokens: Math.min(16000, 2048 + numQuestions * numSets * perCard),
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            system: systemPrompt(numQuestions, numSets, opts),
            messages: [{ role: 'user', content: notes }],
            output_config: {
                effort: 'low',
                format: { type: 'json_schema', schema: cardsSchema(opts.extra) },
            },
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
        const parsed = JSON.parse(text) as { questions: { variants: CardInformation[] }[] };

        // regroup into sets: set k holds the k-th variant of every question.
        // Positions are kept (missing variants stay undefined) so question i lines up across sets.
        return Array.from({ length: numSets }, (_, k) => parsed.questions
            .map((q) => q.variants[k]) as CardInformation[]);
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
