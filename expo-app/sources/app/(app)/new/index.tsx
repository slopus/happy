import React from 'react';
import { View } from 'react-native';

import { PopoverBoundaryProvider, PopoverPortalTargetProvider } from '@/components/ui/popover';
import { NewSessionSimplePanel } from '@/components/sessions/new/components/NewSessionSimplePanel';
import { NewSessionWizard } from '@/components/sessions/new/components/NewSessionWizard';
import { useNewSessionScreenModel } from '@/components/sessions/new/hooks/useNewSessionScreenModel';

function NewSessionScreen() {
    const model = useNewSessionScreenModel();

    if (model.variant === 'simple') {
        return <NewSessionSimplePanel {...model.simpleProps} />;
    }

    const { layout, profiles, agent, machine, footer } = model.wizardProps;

    return (
        <View ref={model.popoverBoundaryRef} style={{ flex: 1, width: '100%' }}>
            <PopoverPortalTargetProvider>
                <PopoverBoundaryProvider boundaryRef={model.popoverBoundaryRef}>
                    <NewSessionWizard
                        layout={layout}
                        profiles={profiles}
                        agent={agent}
                        machine={machine}
                        footer={footer}
                    />
                </PopoverBoundaryProvider>
            </PopoverPortalTargetProvider>
        </View>
    );
}

export default React.memo(NewSessionScreen);
