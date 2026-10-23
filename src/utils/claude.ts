import Anthropic from '@anthropic-ai/sdk';

import logger from 'src/logger';
import { GenerationOptions } from 'src/settings';
import { CardInformation } from './gpt';
import { obsidianFetch } from './http';
import { contextBlock } from './context';

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
    if (opts.context && opts.context.length > 0) {
        lines.push('The <notes> are what the cards are about. <context_note> blocks are background from linked notes: use them to make answers accurate and complete, not as separate topics.');
    }
    if (opts.focus?.trim()) {
        lines.push(`Focus only on: ${opts.focus.trim()}. Skip material unrelated to it; write fewer cards rather than off-topic ones.`);
    }
    return lines.join('\n');
}

function describeApiError(err: InstanceType<typeof Anthropic.APIError>) {
    const body = err.error as { error?: { message?: string } } | undefined;
    const detail = body?.error?.message ?? err.message;
    if (err.status === 404) return `Model not found (${detail}). Check the Claude model name in settings.`;
    if (err.status == null) return `Could not reach the Anthropic API: ${detail}`;
    return `(${err.status}) ${detail}`;
}

// checks key + model without generating anything (no tokens used)
export async function testClaude(apiKey: string, model: string) {
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, fetch: obsidianFetch, maxRetries: 0 });
    try {
        const info = await client.models.retrieve(model);
        return { ok: true, message: `Connected to Claude. Model "${info.id}" is available.` };
    }
    catch (err) {
        if (err instanceof Anthropic.AuthenticationError) return { ok: false, message: 'The Anthropic API key was rejected. Check it in the keychain.' };
        if (err instanceof Anthropic.APIError) return { ok: false, message: describeApiError(err) };
        return { ok: false, message: String(err.message ?? err) };
    }
}

export async function convertNotesToFlashcardsWithClaude(
    apiKey: string,
    model: string,
    notes: string,
    numQuestions: number,
    numSets: number,
    opts: GenerationOptions,
): Promise<CardInformation[][]> {
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, fetch: obsidianFetch, maxRetries: 1 });
    try {
        // one request for all variants so the notes are only sent (and billed) once
        const perCard = (opts.conciseness === 'detailed' ? 120 : 60) + (opts.extra ? 50 : 0);
        const content = opts.context && opts.context.length > 0
            ? `<notes>\n${notes}\n</notes>\n${contextBlock(opts.context)}`
            : notes;
        const response = await client.beta.messages.create({
            model,
            // a ceiling, not a target: only generated tokens are billed. Thinking counts
            // toward it, so leave headroom or the reply gets cut off.
            max_tokens: Math.min(32000, 8000 + numQuestions * numSets * perCard),
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            system: systemPrompt(numQuestions, numSets, opts),
            messages: [{ role: 'user', content }],
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
        else if (err instanceof Anthropic.APIError) message = describeApiError(err);
        logger.log({ level: 'error', message: `Could not generate cards with Claude! ${message}` });
        return [];
    }
}
