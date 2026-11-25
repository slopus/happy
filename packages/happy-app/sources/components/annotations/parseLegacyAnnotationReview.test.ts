import { describe, expect, it } from 'vitest';
import { formatAnnotatedMessage, type AnnotationPromptLabels, type MessageAnnotation } from './annotationDraft';
import { parseLegacyAnnotationReview } from './parseLegacyAnnotationReview';

const zh: AnnotationPromptLabels = { intro: '请结合各条所选原文，逐条回答下面的批注。', annotation: '批注', quote: '所选文本', comment: '用户评论', explain: '请解释这段内容。', additional: '补充说明' };
const en: AnnotationPromptLabels = { intro: 'Please answer each annotation below using its selected passage as context.', annotation: 'Annotation', quote: 'Selected text', comment: 'Your comment', explain: 'Please explain this passage.', additional: 'Additional instructions' };
const locales: readonly AnnotationPromptLabels[] = [
    zh, en,
    { intro: '請結合各則所選原文，逐則回答下方的批註。', annotation: '批註', quote: '所選文字', comment: '你的評論', explain: '請解釋這段內容。', additional: '補充說明' },
    { intro: '以下の各注釈について、それぞれの選択箇所を文脈として使い、順に回答してください。', annotation: '注釈', quote: '選択したテキスト', comment: 'あなたのコメント', explain: 'この箇所を説明してください。', additional: '追加の指示' },
    { intro: 'Ответьте на каждую пометку ниже с учётом соответствующего выделенного фрагмента.', annotation: 'Пометка', quote: 'Выделенный текст', comment: 'Ваш комментарий', explain: 'Пожалуйста, объясните этот фрагмент.', additional: 'Дополнительные инструкции' },
    { intro: 'Odpowiedz na każdą z poniższych adnotacji, używając zaznaczonego w niej fragmentu jako kontekstu.', annotation: 'Adnotacja', quote: 'Zaznaczony tekst', comment: 'Twój komentarz', explain: 'Wyjaśnij ten fragment.', additional: 'Dodatkowe instrukcje' },
    { intro: 'Responda a cada anotação abaixo usando o respectivo trecho selecionado como contexto.', annotation: 'Anotação', quote: 'Texto selecionado', comment: 'Seu comentário', explain: 'Explique este trecho, por favor.', additional: 'Instruções adicionais' },
    { intro: 'Responde a cada anotación de abajo usando su fragmento seleccionado como contexto.', annotation: 'Anotación', quote: 'Texto seleccionado', comment: 'Tu comentario', explain: 'Explica este fragmento, por favor.', additional: 'Instrucciones adicionales' },
    { intro: 'Rispondi a ciascuna annotazione qui sotto usando il relativo passaggio selezionato come contesto.', annotation: 'Annotazione', quote: 'Testo selezionato', comment: 'Il tuo commento', explain: 'Spiega questo passaggio, per favore.', additional: 'Istruzioni aggiuntive' },
    { intro: 'Respon a cadascuna de les anotacions següents fent servir el fragment seleccionat corresponent com a context.', annotation: 'Anotació', quote: 'Text seleccionat', comment: 'El teu comentari', explain: 'Explica aquest fragment, si us plau.', additional: 'Instruccions addicionals' },
];
const annotation = (quote: string, comment: string): MessageAnnotation => ({ id: 'source-id', messageId: 'source-message', revision: 0, quote, comment, anchorText: quote, start: 0, end: quote.length });
const original = () => formatAnnotatedMessage('paws daemon 是不是本来就有？', [annotation('拟新增 delegate_task MCP 工具。', '这个设计是什么意思？'), annotation('Codex 选择角色。', '只能是 Codex 吗？')], zh, false);

describe('legacy annotation display recovery', () => {
    it('recovers the screenshot-style multi-annotation message without inventing source identities', () => {
        expect(parseLegacyAnnotationReview(original())).toEqual({ version: 1, items: [
            { id: 'legacy-1', messageId: '', quote: '拟新增 delegate_task MCP 工具。', comment: '这个设计是什么意思？' },
            { id: 'legacy-2', messageId: '', quote: 'Codex 选择角色。', comment: '只能是 Codex 吗？' },
        ], text: 'paws daemon 是不是本来就有？' });
    });

    it.each(locales)('reads the historical $annotation envelope independent of the active locale', labels => {
        const formatted = formatAnnotatedMessage('Keep the extra request.\n  And indentation.\n', [annotation('first line\n\n> quoted Markdown\n`code`', '  What does this mean?  ')], labels, false);
        expect(parseLegacyAnnotationReview(formatted)).toEqual({ version: 1, items: [{ id: 'legacy-1', messageId: '', quote: 'first line\n\n> quoted Markdown\n`code`', comment: 'What does this mean?' }], text: 'Keep the extra request.\n  And indentation.\n' });
    });

    it('keeps formatter-generated default comments and annotation-only messages', () => {
        expect(parseLegacyAnnotationReview(formatAnnotatedMessage('', [annotation('selected', '')], en))).toMatchObject({ items: [{ quote: 'selected', comment: en.explain }], text: '' });
    });

    it('preserves comment headings and quote-like text that do not form the next envelope', () => {
        const comment = '解释标题\n\n批注 2\n这只是我提到的标题\n\n用户评论\n> 保留这句\n补充说明\n这里不是分隔符';
        expect(parseLegacyAnnotationReview(formatAnnotatedMessage('', [annotation('原文', comment)], zh, false))?.items[0]?.comment).toBe(comment);
    });

    it('keeps an Additional heading inside an earlier comment when another annotation follows', () => {
        const comment = '先讨论这个\n\n补充说明\n这是第一条评论的一部分';
        const parsed = parseLegacyAnnotationReview(formatAnnotatedMessage('真正的补充内容', [annotation('一', comment), annotation('二', '第二条')], zh, false));
        expect(parsed?.items[0]?.comment).toBe(comment);
        expect(parsed?.text).toBe('真正的补充内容');
    });

    it('reads display-only file labels without pretending the short path identifies a source version', () => {
        const file = { path: '/workspace/docs/设计 稿.md', hash: 'baseline-private' };
        const formatted = formatAnnotatedMessage('', [{ ...annotation('文件选文', '修改这里'), file }], zh, false);
        expect(parseLegacyAnnotationReview(formatted)).toEqual({ version: 1, items: [{ id: 'legacy-1', messageId: '', quote: '文件选文', comment: '修改这里', filePath: 'docs/设计 稿.md' }], text: '' });
        expect(formatted).not.toContain(file.hash);
    });

    it('keeps file payloads plain when they contain instructions and version metadata', () => {
        const file = { path: '/workspace/a.md', hash: 'baseline' };
        const formatted = formatAnnotatedMessage('', [{ ...annotation('文件选文', '修改这里'), file }], { ...zh, fileInstructions: '修改前重新读文件。' });
        expect(parseLegacyAnnotationReview(formatted)).toBeNull();
    });

    it.each([
        '', '普通提问', '批注 1\n所选文本\n> 文字\n\n用户评论\n提问',
        '> 普通引用\n\n这个设计是什么意思？',
        '请结合各条所选原文，逐条回答下面的批注。\n\n这段文字只是在讨论批注功能。',
    ])('leaves ordinary user text unchanged: %s', text => {
        expect(parseLegacyAnnotationReview(text)).toBeNull();
    });

    it.each([
        (text: string) => `前言\n${text}`,
        (text: string) => text.replace('批注 1', '批注 0'),
        (text: string) => text.replace('批注 2', '批注 3'),
        (text: string) => text.replace('批注 2', '批注 1'),
        (text: string) => text.replace('所选文本\n', ''),
        (text: string) => text.replace('批注 2\n所选文本\n', '批注 2\n'),
        (text: string) => text.replace('用户评论\n这个设计是什么意思？', '这个设计是什么意思？'),
        (text: string) => text.replace('> 拟新增 delegate_task MCP 工具。', '拟新增 delegate_task MCP 工具。'),
        (text: string) => text.replace('用户评论\n这个设计是什么意思？', '用户评论\n'),
        (text: string) => text.replace('所选文本\n> Codex 选择角色。\n\n用户评论\n', '所选文本\n> Codex 选择角色。\n'),
        (text: string) => text.replace('补充说明\npaws daemon 是不是本来就有？', '补充说明\n'),
        (text: string) => `${text}\n\n补充说明\n无法确定哪个标题是分隔符`,
    ])('falls back for incomplete, reordered or ambiguous formatter envelopes', mutate => {
        expect(parseLegacyAnnotationReview(mutate(original()))).toBeNull();
    });
});
