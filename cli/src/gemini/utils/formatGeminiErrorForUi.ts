import { formatErrorForUi } from '@/ui/formatErrorForUi';

export function formatGeminiErrorForUi(error: unknown, displayedModel?: string | null): string {
    // Parse error message (keep existing UX-focused heuristics; avoid dumping stacks unless needed)
    let errorMsg = 'Process error occurred';

    // Handle Error instances specially to avoid misclassifying them as "empty object" errors.
    const isErrorInstance = error instanceof Error;

    if (typeof error === 'object' && error !== null) {
        const errObj = error as any;

        // Extract error information from various possible formats
        const rawDetails = errObj.data?.details ?? errObj.details ?? '';
        const errorDetails = Array.isArray(rawDetails)
            ? rawDetails.map((d) => (typeof d === 'string' ? d : JSON.stringify(d))).join('\n')
            : String(rawDetails);
        const errorCode = errObj.code || errObj.status || (errObj.response?.status);
        const errorMessage = errObj.message || errObj.error?.message || '';
        const errorString = String(error);

        // Check for 404 error (model not found)
        if (
            errorCode === 404 ||
            errorDetails.includes('notFound') ||
            errorDetails.includes('404') ||
            errorMessage.includes('not found') ||
            errorMessage.includes('404')
        ) {
            const currentModel = displayedModel || 'gemini-2.5-pro';
            errorMsg = `Model "${currentModel}" not found. Available models: gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite`;
        }
        // Check for empty response / internal error after retries exhausted
        else if (
            errorCode === -32603 ||
            errorDetails.includes('empty response') ||
            errorDetails.includes('Model stream ended')
        ) {
            errorMsg = 'Gemini API returned empty response after retries. This is a temporary issue - please try again.';
        }
        // Check for rate limit error (429) - multiple possible formats
        else if (
            errorCode === 429 ||
            errorDetails.includes('429') ||
            errorMessage.includes('429') ||
            errorString.includes('429') ||
            errorDetails.includes('rateLimitExceeded') ||
            errorDetails.includes('RESOURCE_EXHAUSTED') ||
            errorMessage.includes('Rate limit exceeded') ||
            errorMessage.includes('Resource exhausted') ||
            errorString.includes('rateLimitExceeded') ||
            errorString.includes('RESOURCE_EXHAUSTED')
        ) {
            errorMsg = 'Gemini API rate limit exceeded. Please wait a moment and try again. The API will retry automatically.';
        }
        // Check for quota/capacity exceeded error
        else if (
            errorDetails.includes('quota') ||
            errorMessage.includes('quota') ||
            errorString.includes('quota') ||
            errorDetails.includes('exhausted') ||
            errorDetails.includes('capacity')
        ) {
            // Extract reset time from error message like "Your quota will reset after 3h20m35s."
            const resetTimeMatch = (errorDetails + errorMessage + errorString).match(/reset after (\d+h)?(\d+m)?(\d+s)?/i);
            let resetTimeMsg = '';
            if (resetTimeMatch) {
                const parts = resetTimeMatch.slice(1).filter(Boolean).join('');
                if (parts) {
                    resetTimeMsg = ` Quota resets in ${parts}.`;
                }
            }
            errorMsg = `Gemini quota exceeded.${resetTimeMsg} Try using a different model (gemini-2.5-flash-lite) or wait for quota reset.`;
        }
        // Check for authentication error (Google Workspace accounts need project ID)
        else if (
            errorMessage.includes('Authentication required') ||
            errorDetails.includes('Authentication required') ||
            errorCode === -32000
        ) {
            errorMsg =
                `Authentication required. For Google Workspace accounts, you need to set a Google Cloud Project:\n` +
                `  happy gemini project set <your-project-id>\n` +
                `Or use a different Google account: happy connect gemini\n` +
                `Guide: https://goo.gle/gemini-cli-auth-docs#workspace-gca`;
        }
        // Check for empty error (command not found). Ignore Error instances here.
        else if (!isErrorInstance && Object.keys(error).length === 0) {
            errorMsg = 'Failed to start Gemini. Is "gemini" CLI installed? Run: npm install -g @google/gemini-cli';
        }
        // Use message from error object (prefer details if present)
        else if (errObj.message || errorMessage) {
            if (isErrorInstance) {
                errorMsg = errorDetails || formatErrorForUi(error);
            } else {
                errorMsg = errorDetails || errorMessage || errObj.message;
            }
        }
    }

    return errorMsg;
}
