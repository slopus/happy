export function createScrollButtonVisibilityController(params: {
    showDelayMs: number;
    onShow: () => void;
    onHide: () => void;
}) {
    const { showDelayMs, onShow, onHide } = params;

    let isVisible = false;
    let showTimer: ReturnType<typeof setTimeout> | null = null;

    function clearShowTimer() {
        if (showTimer) {
            clearTimeout(showTimer);
            showTimer = null;
        }
    }

    return {
        update(shouldShow: boolean) {
            if (!shouldShow) {
                clearShowTimer();
                if (isVisible) {
                    isVisible = false;
                    onHide();
                }
                return;
            }

            if (isVisible || showTimer) {
                return;
            }

            showTimer = setTimeout(() => {
                showTimer = null;
                if (!isVisible) {
                    isVisible = true;
                    onShow();
                }
            }, showDelayMs);
        },
        dispose() {
            clearShowTimer();
        },
    };
}
