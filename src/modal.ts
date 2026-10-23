import { App, Modal, Notice, Setting } from 'obsidian';
import { Conciseness, Difficulty, GenerationOptions } from './settings';
import { AnkiCache, DeckTagPicker } from './ui';
import { findLinkedNotes, loadContextNotes, parseNoteInput } from './utils/context';

import { 
    exportToAnki,
    getAnkiDecks,
} from './utils/anki';
import { CardInformation } from './utils/gpt';
import { StatusBarElement } from './utils/cusom-types';

// import { SAMPLE_CARD_INFORMATION } from 'sample/sample_card_information';

function checkValidNumGreaterThanZero(text: string|number, inclusiveZero?: boolean) {
    if (typeof text == 'string' && text === '') return false;
    if (isNaN(+text)) return false;
    return inclusiveZero ? +text >= 0 : +text > 0;
}

export type CardGenerator = (
    notes: string,
    numQuestions: number,
    numSets: number,
    options: GenerationOptions,
) => Promise<CardInformation[][]>;
export interface CardTarget {
    deck: string;
    tags: string[];
}

export type CardsConfirmedHandler = (cards: CardInformation[], target?: CardTarget) => void;

export class ExportModal extends Modal {
    n_q: number;
    n_q_valid: boolean;
    n_alt: number;
    n_alt_valid: boolean;
    data: string;
    port: number;
    generate: CardGenerator;
    onConfirm: CardsConfirmedHandler;
    statusBar: StatusBarElement;
    options: GenerationOptions;
    
    constructor(
        app: App,
        statusBar: StatusBarElement,
        data: string,
        ankiConnectPort: number,
        generate: CardGenerator,
        onConfirm: CardsConfirmedHandler,
        defaultOptions: GenerationOptions,
        private target: { cache: AnkiCache; deck: string; tags: string[]; sourcePath: string },
        dafaultNumQuestions?: number,
        defaultNumAlternatives?: number,
    ) {
        super(app);
        this.statusBar = statusBar;
        this.data = data;
        this.port = ankiConnectPort;
        this.generate = generate;
        this.onConfirm = onConfirm;
        this.options = { ...defaultOptions };

        this.n_q = dafaultNumQuestions ?? 5;
        this.n_q_valid = checkValidNumGreaterThanZero(this.n_q);
        this.n_alt = defaultNumAlternatives ?? 3;
        this.n_alt_valid = checkValidNumGreaterThanZero(this.n_alt, true);
    }

    async onOpen() {
        const { contentEl } = this;

        contentEl.createEl('h1', { text: 'How many questions should be generated?' });

        new Setting(contentEl)
            .setName('Number of Questions')
            .addText((text) => text
                .setValue(String(this.n_q))
                .onChange((value) => {
                    this.n_q_valid = checkValidNumGreaterThanZero(value);
                    this.n_q = Number(value)
                })
            );

        new Setting(contentEl)
            .setName('Number of Alternatives')
            .setDesc('Generate multiple versions of questions and choose your favorite ones!')
            .addText((text) => text
                .setValue(String(this.n_alt))
                .onChange((value) => {
                    this.n_alt_valid = checkValidNumGreaterThanZero(value, true);
                    this.n_alt = Number(value)
                })
            );

        new Setting(contentEl)
            .setName('Difficulty')
            .addDropdown((d) => d
                .addOption('easy', 'Easy (recall)')
                .addOption('medium', 'Medium (understanding)')
                .addOption('hard', 'Hard (application)')
                .setValue(this.options.difficulty)
                .onChange((value) => { this.options.difficulty = value as Difficulty })
            );

        new Setting(contentEl)
            .setName('Answer length')
            .addDropdown((d) => d
                .addOption('very-concise', 'Very concise')
                .addOption('concise', 'Concise')
                .addOption('detailed', 'Detailed')
                .setValue(this.options.conciseness)
                .onChange((value) => { this.options.conciseness = value as Conciseness })
            );

        new Setting(contentEl)
            .setName('Extra field')
            .setDesc('Add a short line of context or a mnemonic to each card.')
            .addToggle((t) => t
                .setValue(this.options.extra)
                .onChange((value) => { this.options.extra = value })
            );

        new Setting(contentEl)
            .setName('Focus (optional)')
            .setDesc('Areas to make cards about, e.g. "mechanisms and side effects" or "dates and causes". Leave empty to cover everything.')
            .addTextArea((t) => {
                t.setPlaceholder('Focus on...')
                    .setValue(this.options.focus ?? '')
                    .onChange((value) => { this.options.focus = value });
                t.inputEl.rows = 2;
                t.inputEl.addClass('aa-focus-input');
            });

        // linked notes the AI may use as background
        const linked = findLinkedNotes(this.app, this.data, this.target.sourcePath);
        const chosen = new Set<number>();
        new Setting(contentEl)
            .setName('Linked notes as context')
            .setDesc(linked.length > 0
                ? 'Tick notes the AI may use as background for accurate answers. Each is trimmed to keep token use down.'
                : 'No [[links]] in this text. You can add notes below.');
        if (linked.length > 0) {
            const list = contentEl.createDiv({ cls: 'aa-context-list' });
            linked.forEach((n, i) => {
                const row = list.createEl('label', { cls: 'aa-context-option' });
                const cb = row.createEl('input', { type: 'checkbox' });
                cb.onchange = () => { if (cb.checked) chosen.add(i); else chosen.delete(i); };
                row.createSpan({ text: n.label });
            });
        }
        let typedNotes = '';
        new Setting(contentEl)
            .setName('Add context notes')
            .setDesc('Type [[Note]] or [[Note#Heading]] links, or note names separated by commas.')
            .addText((t) => t
                .setPlaceholder('[[Pharmacology basics]]')
                .onChange((v) => { typedNotes = v; })
            );

        const picker = new DeckTagPicker(contentEl, this.target.cache, this.target.deck, this.target.tags);

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                .setButtonText('Generate Cards')
                .setCta()
                .onClick(async () => {
                    if (!this.n_q_valid || !this.n_alt_valid) {
                        new Notice('An invalid number was entered!');
                        return;
                    }
                    this.close();

                    if (this.statusBar.doDisplayRunning) this.statusBar.doDisplayRunning();
                    const typed = parseNoteInput(this.app, typedNotes, this.target.sourcePath);
                    if (typedNotes.trim() && typed.length === 0) new Notice(`No notes found for "${typedNotes}"; generating without them.`);
                    const picked = [...linked.filter((_, i) => chosen.has(i)), ...typed];
                    this.options.context = picked.length > 0 ? await loadContextNotes(this.app, picked) : undefined;
                    const card_sets: Array<CardInformation[]> = await this.generate(
                        this.data,
                        this.n_q,
                        this.n_alt+1,
                        this.options,
                    );
                    if (this.statusBar.doReset) this.statusBar.doReset();

                    if (card_sets.length === 0) return;
                    // TODO: add loading indicator somewhere
                    new ChoiceModal(
                        this.app,
                        card_sets,
                        // SAMPLE_CARD_INFORMATION,
                        this.n_q,
                        this.n_alt > 0,
                        (cards) => this.onConfirm(cards, { deck: picker.deck || this.target.deck, tags: picker.tags }),
                    ).open();
                })
            );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class QuestionSetWithSelections {
    questions: CardInformation[];
    selected: Set<number>;
    renderFunc: VoidFunction;
    
    constructor(
        questions: CardInformation[],
        onChangeCallback: VoidFunction,
        selectAllOnInit?: boolean,
        selectFirstOnInit?: boolean,
    ) {
        this.questions = [...questions];
        if (selectAllOnInit) this.selected = new Set([...Array(questions.length).keys()])
        else if (selectFirstOnInit && questions.length > 0) this.selected = new Set([0]);
        else this.selected = new Set([]);
        
        this.renderFunc = onChangeCallback;
    }

    renderHtmlList() {
        const htmlList = createEl('ul', { cls: 'question-options-container' });

        const convenienceButtons = createEl('div', { cls: 'question-options__buttons' });
        const selectAllButton = convenienceButtons.createEl('button', { text: 'Select All' });
        selectAllButton.onclick = (e: MouseEvent) => { this.selectAll() };
        const deselectAllButton = convenienceButtons.createEl('button', { text: 'Deselect All' });
        deselectAllButton.onclick = (e: MouseEvent) => { this.deselectAll() };
        convenienceButtons.createEl('span', {
            cls: 'question-options__count',
            text: `${this.selected.size} of ${this.questions.length} selected`,
        });

        htmlList.appendChild(convenienceButtons);

        this.questions.forEach((q: CardInformation, idx: number) => {
            const htmlQuestion = createEl('li');
            htmlQuestion.className = this.selected.has(idx) ? 'question-option --selected' : 'question-option';

            const header = htmlQuestion.createEl('label', { cls: 'question-option__header' });
            const checkbox = header.createEl('input', { type: 'checkbox' });
            checkbox.checked = this.selected.has(idx);
            checkbox.onchange = () => { this.toggleSelect(idx) };
            header.createSpan({ text: `Card ${idx + 1}` });

            // editable in place; edits are kept without re-rendering so focus isn't lost
            htmlQuestion.createEl('div', { cls: 'question-option__label', text: 'Question' });
            const qInput = htmlQuestion.createEl('textarea', { cls: 'question-option__input' });
            qInput.value = q.q;
            qInput.rows = 2;
            qInput.oninput = () => { this.questions[idx] = { ...this.questions[idx], q: qInput.value } };

            htmlQuestion.createEl('div', { cls: 'question-option__label', text: 'Answer' });
            const aInput = htmlQuestion.createEl('textarea', { cls: 'question-option__input' });
            aInput.value = q.a;
            aInput.rows = 2;
            aInput.oninput = () => { this.questions[idx] = { ...this.questions[idx], a: aInput.value } };

            if (q.extra != null) {
                htmlQuestion.createEl('div', { cls: 'question-option__label', text: 'Extra' });
                const eInput = htmlQuestion.createEl('textarea', { cls: 'question-option__input' });
                eInput.value = q.extra;
                eInput.rows = 1;
                eInput.oninput = () => { this.questions[idx] = { ...this.questions[idx], extra: eInput.value } };
            }

            htmlList.appendChild(htmlQuestion);
        })

        return htmlList;
    }

    toggleSelect(idx: number) {
        if (this.selected.has(idx)) {
            this.selected.delete(idx);
        }
        else {
            this.selected.add(idx);
        }
        this.renderFunc();
    }

    selectAll() {
        this.questions.forEach((q: CardInformation, idx: number) => {
            if (this.selected.has(idx)) return;
            this.selected.add(idx);
        });
        this.renderFunc();
    }

    deselectAll() {
        this.selected.clear();
        this.renderFunc();
    }

    extractSelectedQuesions() {
        return this.questions
            .filter((val, idx) => this.selected.has(idx))
            .filter((c) => c.q.trim() && c.a.trim());
    }
}

export class ChoiceModal extends Modal {
    card_sets: Array<CardInformation[]>;
    question_sets: QuestionSetWithSelections[];
    n_sets: number;
    onConfirm: CardsConfirmedHandler;

    curr_set: number;
    
    constructor(
        app: App,
        card_sets: Array<CardInformation[]>,
        n_q: number,
        has_alternatives: boolean,
        onConfirm: CardsConfirmedHandler,
    ) {
        super(app);
        this.renderContent  = this.renderContent.bind(this);

        this.card_sets = card_sets;
        this.onConfirm = onConfirm;

        // create question sets
        this.curr_set = 0;
        this.question_sets = [];

        if (has_alternatives) {
            this.n_sets = n_q;
            for (let i = 0; i < n_q; i++) {
                const question_choices: CardInformation[] = [];
    
                card_sets.forEach((set) => {
                    if (i < set.length && set[i] != null) question_choices.push(set[i]);
                })
                this.question_sets.push(
                    new QuestionSetWithSelections(question_choices, this.renderContent, false, true)
                );
            }
        }
        else {
            this.n_sets = 1;
            this.question_sets.push(
                new QuestionSetWithSelections(card_sets[0].filter((c) => c != null), this.renderContent, true)
            );
        }
    }

    renderContent() {
        const { contentEl } = this;
        contentEl.innerHTML = ''; // use innerHTML to reset content

        // modal title, description
        if (this.n_sets === 1) {
            contentEl.createEl('h1', { text: 'Questions List' });
        }
        else {
            contentEl.createEl('h1', { text: `Question Set No. ${this.curr_set+1}` });
        }
        contentEl.createEl('p', { text: 'Review the generated cards. Edit any question or answer, untick the ones you don\'t want, then confirm.' });

        // get card set to render
        const htmlList = this.question_sets[this.curr_set].renderHtmlList();
        contentEl.appendChild(htmlList);

        // create buttons depending on how many sets there are
        if (this.n_sets > 1) {
            // create buttons in modal footer
            const htmlButtons = createEl('div', { cls: 'modal-buttons' });
            // previous button
            new Setting(htmlButtons)
                .addButton((btn) =>
                    btn
                    .setButtonText('Previous')
                    .setCta()
                    .setClass(this.curr_set === 0 ? 'disabled' : 'enabled')
                    .setDisabled(this.curr_set === 0)
                    .onClick(() => {
                        this.curr_set -= 1;
                        this.renderContent();
                    })
            );
    
            // next/confirm button
            if (this.curr_set < this.n_sets-1){
                new Setting(htmlButtons)
                    .addButton((btn) =>
                        btn
                        .setButtonText('Next')
                        .setCta()
                        .onClick(() => {
                            this.curr_set += 1;
                            this.renderContent();
                        })
                );
            }
            else {
                new Setting(htmlButtons)
                    .addButton((btn) =>
                        btn
                        .setButtonText('Confirm Selection')
                        .setCta()
                        .onClick(async () => {
                            const allSelectedCards: CardInformation[] = [];
                            this.question_sets.forEach((set) => {
                                const selectedCards = set.extractSelectedQuesions()
                                allSelectedCards.push(...selectedCards);
                            })
                            if (allSelectedCards.length === 0) {
                                new Notice('No cards selected');
                                return;
                            }
                            this.close();
                            this.onConfirm(allSelectedCards);
                        })
                );
            }
            contentEl.appendChild(htmlButtons);
        } else {
            new Setting(contentEl)
                .addButton((btn) =>
                    btn
                    .setButtonText('Confirm Selection')
                    .setCta()
                    .onClick(async () => {
                        const allSelectedCards: CardInformation[] = [];
                        this.question_sets.forEach((set) => {
                            const selectedCards = set.extractSelectedQuesions()
                            allSelectedCards.push(...selectedCards);
                        })
                        if (allSelectedCards.length === 0) {
                            new Notice('No cards selected');
                            return;
                        }
                        this.close();
                        this.onConfirm(allSelectedCards);
                    })
            );
        }
    }

    onOpen() {
        this.renderContent();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

export class AnkiDeckModal extends Modal {
    port: number;
    cardsToExport: CardInformation[];
    decks: string[];
    selectedDeck: string;
    isDataFetched: boolean;
    isDataError: boolean;

    constructor(
        app: App,
        port: number,
        defaultDeck: string,
        allSelectedCards: CardInformation[],
    ) {
        super(app);
        this.renderContent  = this.renderContent.bind(this);
        this.port = port;
        this.selectedDeck = defaultDeck;
        this.cardsToExport = allSelectedCards;

        this.isDataFetched = false;
    }

    async fetchData() {
        const fetchedDecks = await getAnkiDecks(this.port);
        this.decks = fetchedDecks;
        this.isDataFetched = true;


        if (this.selectedDeck === '' && fetchedDecks.length > 0) {
            this.selectedDeck = fetchedDecks[0];
        }
    }

    renderHtmlList() {
        const htmlList = createEl('ul', { cls: 'deck-options-container' });
        const convenienceButtons = createEl('div', { cls: 'deck-options__buttons' });

        htmlList.appendChild(convenienceButtons);

        this.decks.forEach((d: string) => {
            const htmlDeck = createEl('li');
            htmlDeck.appendChild(createEl('h3', { text: d }));
            if (this.selectedDeck === d) {
                htmlDeck.className = 'deck-option --selected'
            }
            else {
                htmlDeck.className = 'deck-option'
            }
            htmlDeck.onclick = () => {
                this.selectedDeck = d;
                this.renderContent();
            };
            htmlList.appendChild(htmlDeck);
        })

        return htmlList;
    }

    renderContent() {
        const { contentEl } = this;
        contentEl.innerHTML = ''; // use innerHTML to reset content

        // modal title
        contentEl.createEl('h1', { text: 'Anki Decks' });

        if (!this.isDataFetched) {
            const centerContainer = contentEl.createEl('div', { cls: 'error-notice' });
            centerContainer.createEl('h4', { text: 'loading data...' });
            return;
        }
        
        if (this.decks.length === 0) {
            const centerContainer = contentEl.createEl('div', { cls: 'error-notice' });
            centerContainer.createEl('h4', { text: 'Either an error occured or no Anki decks were found' });
            const refreshButton = centerContainer.createEl('button', { text: 'Refresh' });
            refreshButton.onclick = async () => {
                this.renderContent();
                await this.fetchData();
                this.renderContent();
            }
            return;
        }

        // modal description
        contentEl.createEl('p', { text: 'Pick one of the following available Anki decks to export to.' });

        // get deck list to render
        const htmlList = this.renderHtmlList();
        contentEl.appendChild(htmlList);

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                .setButtonText('Confirm and Export')
                .setDisabled(this.selectedDeck === '')
                .setCta()
                .onClick(async () => {
                    if (this.selectedDeck === '') return;
                
                    this.close();
                    exportToAnki(
                        this.cardsToExport,
                        this.port,
                        this.selectedDeck,
                    );
                })
        );
    }

    async onOpen() {
        this.renderContent();
        await this.fetchData();
        this.renderContent();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

export interface NoteHeading {
    heading: string;
    level: number;
    line: number;
}

// pick which heading sections of a note to generate cards from
export class HeadingPickerModal extends Modal {
    selected = new Set<number>();

    constructor(
        app: App,
        private headings: NoteHeading[],
        private onConfirm: (chosen: NoteHeading[]) => void,
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h1', { text: 'Generate cards from headings' });
        contentEl.createEl('p', { text: 'Tick the sections to send to the AI. Each section includes its sub-headings.' });

        const list = contentEl.createEl('div', { cls: 'heading-options-container' });
        this.headings.forEach((h, idx) => {
            const row = list.createEl('label', { cls: 'heading-option' });
            row.style.paddingLeft = `${(h.level - 1) * 1.25}em`;
            const checkbox = row.createEl('input', { type: 'checkbox' });
            checkbox.onchange = () => {
                if (checkbox.checked) this.selected.add(idx);
                else this.selected.delete(idx);
            };
            row.createSpan({ text: h.heading });
        });

        new Setting(contentEl)
            .addButton((btn) => btn
                .setButtonText('Continue')
                .setCta()
                .onClick(() => {
                    if (this.selected.size === 0) {
                        new Notice('Select at least one heading');
                        return;
                    }
                    this.close();
                    this.onConfirm(this.headings.filter((_, idx) => this.selected.has(idx)));
                })
            );
    }

    onClose() {
        this.contentEl.empty();
    }
}
