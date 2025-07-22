import * as React from 'react';

export const Deferred = React.memo((props: { children: React.ReactNode }) => {
    const [enabled, setEnabled] = React.useState(false);

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