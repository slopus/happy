export function parseAskUserQuestionResultAnswers(
    result: unknown,
    questionTexts: string[],
): Record<string, string> | null {
    let parsed: unknown = result;
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            return null;
        }
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const answers = (parsed as any).answers;
    if (Array.isArray(answers)) {
        const byQuestion: Record<string, string> = {};
        questionTexts.forEach((question, index) => {
            const value = answers[index];
            if (typeof value === 'string' && value.length > 0) {
                byQuestion[question] = value;
            }
        });
        return Object.keys(byQuestion).length > 0 ? byQuestion : null;
    }
    if (answers && typeof answers === 'object') {
        const byQuestion: Record<string, string> = {};
        for (const [key, value] of Object.entries(answers)) {
            if (typeof value === 'string' && value.length > 0) {
                byQuestion[key] = value;
            }
        }
        return Object.keys(byQuestion).length > 0 ? byQuestion : null;
    }
    return null;
}
