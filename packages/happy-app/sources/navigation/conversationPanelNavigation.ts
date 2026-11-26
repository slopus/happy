/** A focused conversation may temporarily reveal an auxiliary inspector without
 * committing the user's normal sidebar/zen preference. Its close action takes
 * precedence over the shared sidebar toggle while that inspector is active. */
let temporary: { owner: object; close: () => void } | undefined;
export function registerConversationPanelClose(owner: object, close: () => void) {
    const entry = { owner, close };
    temporary = entry;
    return () => { if (temporary === entry) temporary = undefined; };
}
export function closeTemporaryConversationPanel() {
    if (!temporary) return false;
    temporary.close();
    return true;
}
