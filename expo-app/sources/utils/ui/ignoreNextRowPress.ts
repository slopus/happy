export function ignoreNextRowPress(ref: { current: boolean }): void {
    ref.current = true;
    setTimeout(() => {
        ref.current = false;
    }, 0);
}

