import type { AnnotationReview } from './annotationMessage';

type LegacyLabels = Readonly<{ intro: string; annotation: string; quote: string; comment: string; additional: string }>;

// These are historical wire-format labels, intentionally independent of the current UI locale.
// Keep old values when translations change so existing conversations remain readable.
const LEGACY_LABELS: readonly LegacyLabels[] = [
    { intro: 'Please answer each annotation below using its selected passage as context.', annotation: 'Annotation', quote: 'Selected text', comment: 'Your comment', additional: 'Additional instructions' },
    { intro: '请结合各条所选原文，逐条回答下面的批注。', annotation: '批注', quote: '所选文本', comment: '用户评论', additional: '补充说明' },
    { intro: '請結合各則所選原文，逐則回答下方的批註。', annotation: '批註', quote: '所選文字', comment: '你的評論', additional: '補充說明' },
    { intro: '以下の各注釈について、それぞれの選択箇所を文脈として使い、順に回答してください。', annotation: '注釈', quote: '選択したテキスト', comment: 'あなたのコメント', additional: '追加の指示' },
    { intro: 'Ответьте на каждую пометку ниже с учётом соответствующего выделенного фрагмента.', annotation: 'Пометка', quote: 'Выделенный текст', comment: 'Ваш комментарий', additional: 'Дополнительные инструкции' },
    { intro: 'Odpowiedz na każdą z poniższych adnotacji, używając zaznaczonego w niej fragmentu jako kontekstu.', annotation: 'Adnotacja', quote: 'Zaznaczony tekst', comment: 'Twój komentarz', additional: 'Dodatkowe instrukcje' },
    { intro: 'Responda a cada anotação abaixo usando o respectivo trecho selecionado como contexto.', annotation: 'Anotação', quote: 'Texto selecionado', comment: 'Seu comentário', additional: 'Instruções adicionais' },
    { intro: 'Responde a cada anotación de abajo usando su fragmento seleccionado como contexto.', annotation: 'Anotación', quote: 'Texto seleccionado', comment: 'Tu comentario', additional: 'Instrucciones adicionales' },
    { intro: 'Rispondi a ciascuna annotazione qui sotto usando il relativo passaggio selezionato come contesto.', annotation: 'Annotazione', quote: 'Testo selezionato', comment: 'Il tuo commento', additional: 'Istruzioni aggiuntive' },
    { intro: 'Respon a cadascuna de les anotacions següents fent servir el fragment seleccionat corresponent com a context.', annotation: 'Anotació', quote: 'Text seleccionat', comment: 'El teu comentari', additional: 'Instruccions addicionals' },
];

function annotationNumber(line: string, labels: LegacyLabels): number | null {
    const prefix = `${labels.annotation} `;
    if (!line.startsWith(prefix)) return null;
    const number = line.slice(prefix.length);
    return /^[1-9]\d*$/.test(number) && Number.isSafeInteger(Number(number)) ? Number(number) : null;
}

function isFileLabel(line: string): boolean {
    // Display templates contain only the final path components, without a baseline hash.
    // Do not guess at serialized metadata or arbitrary prose between the template labels.
    return !!line && line === line.trim() && !/[\r\n\[\]{}<>]/.test(line)
        && (line.includes('/') || /^[^.\s]+(?:\.[^.\s]+)+$/.test(line) || /^\.[^.\s][^\s]*$/.test(line));
}

function readSection(lines: readonly string[], start: number, labels: LegacyLabels) {
    const number = annotationNumber(lines[start] ?? '', labels);
    if (number === null) return null;
    let cursor = start + 1;
    let filePath: string | undefined;
    if (lines[cursor] !== labels.quote) {
        if (!isFileLabel(lines[cursor] ?? '') || lines[cursor + 1] !== labels.quote) return null;
        filePath = lines[cursor++];
    }
    cursor++;
    const quote: string[] = [];
    while (lines[cursor]?.startsWith('> ')) quote.push(lines[cursor++]!.slice(2));
    if (!quote.length || !quote.join('\n').trim() || lines[cursor] !== '' || lines[cursor + 1] !== labels.comment) return null;
    return { number, quote: quote.join('\n'), filePath, commentStart: cursor + 2 };
}

/** Recover only the complete formatter envelope; uncertain or damaged messages stay plain text. */
export function parseLegacyAnnotationReview(text: string): AnnotationReview | null {
    const labels = LEGACY_LABELS.find(candidate => text.startsWith(`${candidate.intro}\n\n`));
    if (!labels) return null;
    const lines = text.slice(labels.intro.length + 2).split('\n');
    const items: AnnotationReview['items'][number][] = [];
    let start = 0;
    while (start < lines.length) {
        const section = readSection(lines, start, labels);
        if (!section || section.number !== items.length + 1) return null;
        let nextSection: number | undefined;
        const additionalStarts: number[] = [];
        for (let cursor = section.commentStart; cursor + 1 < lines.length; cursor++) {
            if (lines[cursor] !== '') continue;
            const next = cursor + 1;
            const number = annotationNumber(lines[next] ?? '', labels);
            if (number !== null) {
                // A heading mentioned in a comment is ordinary text unless its quote label
                // also starts an annotation envelope. A damaged envelope must not be hidden.
                const quoteStart = lines[next + 1] === labels.quote
                    || (isFileLabel(lines[next + 1] ?? '') && lines[next + 2] === labels.quote);
                if (!quoteStart && (lines[next + 1]?.startsWith('> ') || lines[next + 1] === labels.comment
                    || lines[next + 1] === '[Workspace file annotation]')) return null;
                if (quoteStart) {
                    if (!readSection(lines, next, labels) || number !== section.number + 1) return null;
                    nextSection = cursor;
                    break;
                }
            }
            if (lines[next] === labels.additional) additionalStarts.push(cursor);
        }
        // An Additional heading before another annotation belongs to that annotation's
        // comment. In the final section duplicate delimiters have no unambiguous meaning.
        if (nextSection === undefined && additionalStarts.length > 1) return null;
        const additional = nextSection === undefined ? additionalStarts[0] : undefined;
        const end = nextSection ?? additional ?? lines.length;
        const comment = lines.slice(section.commentStart, end).join('\n');
        if (!comment || comment !== comment.trim()) return null;
        items.push({ id: `legacy-${section.number}`, messageId: '', quote: section.quote, comment, ...(section.filePath ? { filePath: section.filePath } : {}) });
        if (nextSection === undefined) {
            const additionalText = additional === undefined ? '' : lines.slice(additional + 2).join('\n');
            if (additional !== undefined && !additionalText.trim()) return null;
            return { version: 1, items, text: additionalText };
        }
        start = nextSection + 1;
    }
    return null;
}
