import { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions';
import { ANKI_CONNECT_DEFAULT_PORT } from './utils/anki';

export interface GptAdvancedOptions extends Partial<ChatCompletionCreateParamsBase> {
	temperature: number;
	top_p: number;
	frequency_penalty: number;
	presence_penalty: number;
	max_tokens_per_question: number;
}

export interface QuestionGenerationDefaults {
	textSelection: {
		numQuestions: number,
		numAlternatives: number,
	},
	file: {
		numQuestions: number,
		numAlternatives: number,
	},
}

export type AiProvider = 'anthropic' | 'openai';
export type ConflictPolicy = 'newest' | 'obsidian' | 'anki';
export type FieldDisplay = 'show' | 'dim' | 'hide';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type Conciseness = 'very-concise' | 'concise' | 'detailed';

export interface GenerationOptions {
	difficulty: Difficulty;
	conciseness: Conciseness;
	extra: boolean;
	focus?: string;   // per-run instruction, e.g. "mechanisms and side effects"
	context?: { title: string; text: string }[];   // linked notes sent as background
}

export interface SyncSettings {
	basicSeparator: string;
	reversedSeparator: string;
	clozeHighlights: boolean;
	basicModel: string;
	reversedModel: string;
	clozeModel: string;
	extraField: string;
	tags: string;
	conflictPolicy: ConflictPolicy;
	deleteRemovedNotes: boolean;
	vaultSyncTag: string;
	autoSyncMinutes: number;
}

export interface PluginSettings {
	ankiConnectPort: number;
	ankiDestinationDeck: string;
	fieldDisplay: FieldDisplay;
	aiProvider: AiProvider;
	// names of secrets in Obsidian's keychain (app.secretStorage), never the keys themselves
	anthropicSecretId: string;
	anthropicModel: string;
	aiInsertIntoNote: boolean;
	syncDialog: boolean;
	aiHeading: string;
	generation: GenerationOptions;
	openAiSecretId: string;
	sync: SyncSettings;
	gptAdvancedOptions: GptAdvancedOptions;
	questionGenerationDefaults: QuestionGenerationDefaults;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	ankiConnectPort: ANKI_CONNECT_DEFAULT_PORT,
	ankiDestinationDeck: '',
	fieldDisplay: 'dim',
	aiProvider: 'anthropic',
	anthropicSecretId: 'auto-anki-anthropic',
	anthropicModel: 'claude-opus-5-5',
	aiInsertIntoNote: true,
	syncDialog: true,
	aiHeading: 'Flashcards',
	generation: {
		difficulty: 'medium',
		conciseness: 'concise',
		extra: false,
	},
	openAiSecretId: 'auto-anki-openai',
	sync: {
		basicSeparator: '::',
		reversedSeparator: ':::',
		clozeHighlights: true,
		basicModel: 'Basic',
		reversedModel: 'Basic (and reversed card)',
		clozeModel: 'Cloze',
		extraField: 'Extra',
		tags: 'obsidian',
		conflictPolicy: 'newest',
		deleteRemovedNotes: false,
		vaultSyncTag: 'flashcards',
		autoSyncMinutes: 0,
	},
	gptAdvancedOptions: {
		temperature: 1,
		top_p: 1.0,
		frequency_penalty: 0.0,
		presence_penalty: 0.0,
		max_tokens_per_question: 100,
	},
	questionGenerationDefaults: {
		textSelection: {
			numQuestions: 1,
			numAlternatives: 0,
		},
		file: {
			numQuestions: 5,
			numAlternatives: 0,
		},
	},
}
