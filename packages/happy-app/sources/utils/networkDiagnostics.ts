import axios from 'axios';

function stringifyData(data: unknown): string | undefined {
    if (data === undefined || data === null) {
        return undefined;
    }

    try {
        const text = typeof data === 'string' ? data : JSON.stringify(data);
        return text.length > 240 ? `${text.slice(0, 240)}...` : text;
    } catch {
        return String(data);
    }
}

export function describeNetworkError(error: unknown): string {
    if (axios.isAxiosError(error)) {
        const parts: string[] = [];
        if (error.code) {
            parts.push(`code=${error.code}`);
        }
        if (error.response) {
            parts.push(`status=${error.response.status}`);
            const body = stringifyData(error.response.data);
            if (body) {
                parts.push(`body=${body}`);
            }
        } else if (error.request) {
            parts.push('no_response=true');
        }
        if (error.message) {
            parts.push(`message=${error.message}`);
        }
        return parts.join(' ') || 'axios_error';
    }

    if (error instanceof Error) {
        return `${error.name}: ${error.message}`;
    }

    return String(error);
}
