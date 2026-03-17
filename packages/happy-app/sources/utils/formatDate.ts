export function formatDate(value: string | null): string {
    if (!value) {
        return '-';
    }
    try {
        return new Date(value).toLocaleString();
    } catch (_error) {
        return value;
    }
}
