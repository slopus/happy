export interface WebModalBackdropProps {
    onClose: () => void;
    testID: string;
}

/** Existing native sheets retain their explicit close controls. */
export function WebModalBackdrop(_props: WebModalBackdropProps) { return null; }
