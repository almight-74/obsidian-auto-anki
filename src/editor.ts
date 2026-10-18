import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';

import { FieldDisplay } from './settings';

// {{deck::}}, {{tag::}}, {{extra::}} fields and <!--anki:ID--> markers on card lines
export const CARD_FIELD_REGEX = /\{\{(?:deck|tags?|extra)::(?:(?!\}\}).)*\}\}|<!--\s*anki:\d+\s*-->/gi;

const dimMark = Decoration.mark({ class: 'aa-card-field --dim' });
const showMark = Decoration.mark({ class: 'aa-card-field' });
const hidden = Decoration.replace({});

export function cardFieldsExtension(getDisplay: () => FieldDisplay) {
    return ViewPlugin.fromClass(class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
            this.decorations = this.build(view);
        }

        update(u: ViewUpdate) {
            if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = this.build(u.view);
        }

        build(view: EditorView) {
            const display = getDisplay();
            const builder = new RangeSetBuilder<Decoration>();
            // lines with the cursor/selection always show raw text so fields stay editable
            const activeLines = new Set<number>();
            for (const r of view.state.selection.ranges) {
                const from = view.state.doc.lineAt(r.from).number;
                const to = view.state.doc.lineAt(r.to).number;
                for (let n = from; n <= to; n++) activeLines.add(n);
            }

            for (const { from, to } of view.visibleRanges) {
                const text = view.state.sliceDoc(from, to);
                for (const m of text.matchAll(CARD_FIELD_REGEX)) {
                    const start = from + (m.index ?? 0);
                    const end = start + m[0].length;
                    const onActiveLine = activeLines.has(view.state.doc.lineAt(start).number);
                    if (display === 'hide' && !onActiveLine) builder.add(start, end, hidden);
                    else if (display === 'show') builder.add(start, end, showMark);
                    else builder.add(start, end, dimMark);
                }
            }
            return builder.finish();
        }
    }, { decorations: (v) => v.decorations });
}

// reading view: wrap fields in spans so CSS can show / dim / hide them
export function wrapCardFields(el: HTMLElement) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        CARD_FIELD_REGEX.lastIndex = 0;
        if (CARD_FIELD_REGEX.test(node.data)) nodes.push(node);
    }
    for (const node of nodes) {
        const frag = document.createDocumentFragment();
        let last = 0;
        for (const m of node.data.matchAll(CARD_FIELD_REGEX)) {
            const idx = m.index ?? 0;
            frag.append(node.data.slice(last, idx));
            frag.append(createSpan({ cls: 'aa-card-field', text: m[0] }));
            last = idx + m[0].length;
        }
        frag.append(node.data.slice(last));
        node.replaceWith(frag);
    }
}
