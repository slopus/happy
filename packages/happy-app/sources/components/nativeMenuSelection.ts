/**
 * Whether a native menu group is a choice, drawn with the system's own
 * selection state, or a list of actions, drawn as plain rows.
 *
 * `null` is the actions case (see NativeSettingsMenuGroup.selectedKey);
 * `undefined` is a choice with nothing chosen yet.
 */
export function isNativeMenuChoice(group: { selectedKey: string | null | undefined }) {
    return group.selectedKey !== null;
}
