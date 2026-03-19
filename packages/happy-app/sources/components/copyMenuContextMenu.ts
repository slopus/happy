export function handleCopyMenuContextMenu(
    event: {
        preventDefault: () => void;
        nativeEvent: {
            pageX: number;
            pageY: number;
        };
    },
    onOpen: (point: { pageX: number; pageY: number }) => void,
) {
    event.preventDefault();
    onOpen({
        pageX: event.nativeEvent.pageX,
        pageY: event.nativeEvent.pageY,
    });
}
