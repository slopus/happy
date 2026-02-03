import * as React from 'react';

export const Deferred = React.memo((props: { children: React.ReactNode, enabled?: boolean }) => {
    const [enabled, setEnabled] = React.useState(props.enabled ?? false);

    React.useEffect(() => {
        let timeout = setTimeout(() => {
            setEnabled(true);
        }, 10);
        return () => clearTimeout(timeout);
    }, []);

    return (
        <React.Fragment>
            {enabled ? props.children : null}
        </React.Fragment>
    )
});