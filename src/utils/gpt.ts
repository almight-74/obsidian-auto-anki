import OpenAI from 'openai';
import type {
    ChatCompletion,
    ChatCompletionCreateParams,
    ChatCompletionUserMessageParam,
    ChatCompletionAssistantMessageParam,
    ChatCompletionSystemMessageParam,
} from 'openai/resources';
import logger from 'src/logger';
import { GenerationOptions, GptAdvancedOptions } from 'src/settings';

export interface CardInformation {
    q: string;
    a: string;
    extra?: string;
}

export function checkGpt(openAiKey: string) {
    // check gpt api key
    if (openAiKey === '') {
        logger.log({
            level: 'error',
            message: "OpenAI API key not provided! Please go to your 'Auto Anki' settings to set an API key."
        });
        return false;
    }
    return true;
}

const SAMPLE_NOTE = `A numeral system is a writing system for expressing numbers. It is a mathematical notation for representing numbers of a given set, using digits or other symbols in a consistent manner.

Ideally, a numeral system will:
- represent a useful set of numbers (eg: integers, rational numbers)
- give every number represented a unique representation
- reflect the algebraic and arithmetic structure of the numbers

#### Positional Notation
> also known as the "place-value notation"

Uses a **radix**/**base** (eg: base 10) to indicate the number of unique *digits* that are used to represent numbers in a position until the position of the digit is used to signify a power of the *base* number.

- Positional Systems with Base 2: [[Binary Numeral System]]
- Positional Systems with Base 8: Octal Numeral System
- Positional Systems with Base 10: Decimal Numeral System
- Positional Systems with Base 12: Duodecimal (dozenal) Numeral System
- Positional Systems with Base 16: Hexadecimal Numeral System
- Positional Systems with Base 20: Vigesimal Numeral System
- Positional Systems with Base 60: Sexagesimal Numeral System
`

const SAMPLE_OUTPUT = [
    { q: 'What is a numeral system?', a: 'A numeral system is a writing system for expressing numbers, using digits or other symbols in a consistent manner.' },
    { q: 'What is the goal of a numeral system?', a: 'The goal of a numeral system is to represent a useful set of numbers (eg: integers, rational numbers), give every number represented a unique representation, and reflect the algebraic and arithmetic structure of the numbers.' },
    { q: 'What is a positional notation also known as?', a: 'Place-value Notation' },
    { q: 'What is a radix/base used for in the context of positional notation?', a: 'To indicate the number of unique digits that are used to represent numbers in a position until the position of the digit is used to signify a power of the base number' },
    { q: 'What numeral system uses a base of 2?', a: 'Binary Numeral System' },
    { q: 'What numeral system uses a base of 8?', a: 'Octal Numeral System' },
    { q: 'What numeral system uses a base of 10?', a: 'Decimal Numeral System' },
    { q: 'What numeral system uses a base of 12?', a: 'Duodecimal Numeral System' },
    { q: 'What numeral system uses a base of 16?', a: 'Hexadecimal Numeral System' },
    { q: 'What numeral system uses a base of 20?', a: 'Vigesimal Numeral System' },
    { q: 'What numeral system uses a base of 60?', a: 'Sexagesimal Numeral System' },
    { q: 'What is binary number representation?', a: 'Binary number representation is a number expressed in the base-2 numeral system or binary numeral system.' },
    // { q: '', a: '' },
]

// a short example is enough to show the format; repeating it per question only costs tokens
const SAMPLE_SIZE = 3;

const GPT_DIFFICULTY: Record<GenerationOptions['difficulty'], string> = {
    'easy': 'recall of key terms and definitions',
    'medium': 'understanding of concepts and how they relate',
    'hard': 'application, comparison and edge cases',
};

const GPT_CONCISENESS: Record<GenerationOptions['conciseness'], string> = {
    'very-concise': 'a few words, no full sentences',
    'concise': 'at most one short sentence',
    'detailed': '1-3 sentences including the key reasoning',
};

function createMessages(notes: string, num: number, opts: GenerationOptions) {
    const messages = [];
    const format = opts.extra
        ? '{ "questions_answers": [{ "q": "<question>", "a": "<answer>", "extra": "<one line of context or mnemonic>" }] }'
        : '{ "questions_answers": [{ "q": "<question>", "a": "<answer>" }] }';
    messages.push({
        role: 'system',
        content: `Make ${num} spaced-repetition questions and answers from the given markdown notes.
- JSON format: ${format}
- cover the whole notes, no similar or repeated questions
- difficulty: ${GPT_DIFFICULTY[opts.difficulty]}
- answers: ${GPT_CONCISENESS[opts.conciseness]}`,
    } as ChatCompletionSystemMessageParam)

    // Insert sample user prompt
    messages.push({
        role: 'user',
        content: SAMPLE_NOTE,
    } as ChatCompletionUserMessageParam);
    

    // Insert sample assistant output (JSON format)
    messages.push({
        role: 'assistant',
        content: JSON.stringify({
            "questions_answers": SAMPLE_OUTPUT.slice(0, SAMPLE_SIZE)
        }),
    } as ChatCompletionAssistantMessageParam);

    // Insert notes
    messages.push({
        role: 'user',
        content: `\n${notes.trim()}\n`,
    } as ChatCompletionUserMessageParam);

    return messages;
}
  
export async function convertNotesToFlashcards(
    apiKey: string,
    notes: string,
    num_q: number,
    num: number,
    options: GptAdvancedOptions,
    generationOptions: GenerationOptions,
) {
    let response: ChatCompletion;
    try {
        const client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });

        const {
            max_tokens_per_question: tokensPerQuestion,
            ...completionOptions
        } = options;
    
        // for anki connect, the output
        response = await client.chat.completions.create({
            ...completionOptions,
            model: 'gpt-3.5-turbo-1106',
            messages: createMessages(notes, num_q, generationOptions),
            max_tokens: tokensPerQuestion * num_q,
            n: num,
            stream: false,
            response_format: { type: "json_object" },
        } as ChatCompletionCreateParams) as ChatCompletion;
    }
    catch (err) {
        if (!err.response) {
            logger.log({
                level: 'error',
                message: `Could not connect to OpenAI! ${err.message}`
            });
        }
        else {
            const errStatus = err.response.status;
            const errBody = err.response.data;
            let supportingMessage = `(${errBody.error.code}) ${errBody.error.message}`;
            if (errStatus === 401) {
                supportingMessage = 'Check that your API Key is correct/valid!';
            }
            logger.log({
                level: 'error',
                message: `ERR ${errStatus}: Could not connect to OpenAI! ${supportingMessage}`
            });
        }
        return [];
    }

    try {
        const card_choices: Array<CardInformation[]> = [];
        logger.log({
            level: 'info',
            message: `Generated ${response.choices.length} choices!`,
        });

        response.choices.forEach((set, idx) => {
            const content = set.message.content ?? '';
            logger.log({
                level: 'info',
                message: content,
            });
            const parsedContent = JSON.parse(content);
            if(parsedContent["questions_answers"] === undefined) throw "";
            logger.log({
                level: 'info',
                message: `Choice ${idx}: generated ${parsedContent["questions_answers"].length} questions and answers`,
            });
            card_choices.push(parsedContent['questions_answers'] as CardInformation[])
        })
        return card_choices;
    }
    catch (err) {
        logger.log({
            level: 'error',
            message: `Something happened while parsing OpenAI output! Please contact a developer for more support.`,
        });
        return [];
    }
}