// Unlike an in-memory fallback, failed durable writes must stop account switching.
export const accountIndex = {
    getString(key: string): string | undefined {
        return typeof localStorage === 'undefined' ? undefined : localStorage.getItem(`paws.accounts.${key}`) ?? undefined;
    },
    set(key: string, value: string): void { localStorage.setItem(`paws.accounts.${key}`, value); },
    delete(key: string): void { localStorage.removeItem(`paws.accounts.${key}`); },
};
