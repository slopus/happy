import { t } from '@/text';
import type { InlineQuestion, InlineQuestionOption } from './InlineQuestionForm';

function normalizeOption(raw: unknown): InlineQuestionOption | null {
    if (typeof raw === 'string') {
        return raw.length > 0 ? { label: raw } : null;
    }
    if (raw && typeof raw === 'object' && typeof (raw as any).label === 'string') {
        const description = (raw as any).description;
        return {
            label: (raw as any).label,
            description: typeof description === 'string' ? description : null,
        };
    }
    return null;
}

function extractOptions(raw: any): { options: InlineQuestionOption[]; wrapperMultiSelect?: boolean } {
    const rawOptions = raw?.options;

    const wrapper = Array.isArray(rawOptions)
        ? (rawOptions.length === 1 && rawOptions[0] && typeof rawOptions[0] === 'object' && Array.isArray((rawOptions[0] as any).choices)
            ? rawOptions[0] as any
            : null)
        : (rawOptions && typeof rawOptions === 'object' && Array.isArray((rawOptions as any).choices)
            ? rawOptions as any
            : null);

    if (wrapper) {
        return {
            options: wrapper.choices.map(normalizeOption).filter((o: InlineQuestionOption | null): o is InlineQuestionOption => o !== null),
            wrapperMultiSelect: typeof wrapper.multiSelect === 'boolean' ? wrapper.multiSelect : undefined,
        };
    }

    if (Array.isArray(rawOptions)) {
        return {
            options: rawOptions.map(normalizeOption).filter((o: InlineQuestionOption | null): o is InlineQuestionOption => o !== null),
        };
    }

    return { options: [] };
}

export function parseRawRequestUserInputQuestions(rawInput: unknown): InlineQuestion[] {
    const input = (rawInput as any)?.input ?? rawInput as any;
    const rawQuestions = Array.isArray(input?.questions)
        ? input.questions
        : (typeof input?.question === 'string' ? [input] : []);

    const questions: InlineQuestion[] = [];
    rawQuestions.forEach((raw: any, index: number) => {
        if (!raw || typeof raw.question !== 'string') return;
        const { options, wrapperMultiSelect } = extractOptions(raw);
        questions.push({
            id: `raw-${index}`,
            header: typeof raw.header === 'string' ? raw.header : t('tools.names.question'),
            question: raw.question,
            options,
            multiSelect: typeof raw.multiSelect === 'boolean' ? raw.multiSelect : (wrapperMultiSelect ?? false),
            allowCustom: raw.allowCustom !== false,
        });
    });
    return questions;
}
