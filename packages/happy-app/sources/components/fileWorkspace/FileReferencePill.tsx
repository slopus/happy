import * as React from 'react';
import { View } from 'react-native';
import { useFileWorkspace } from './context';
import { WorkspaceButton as Button } from './WorkspaceButton';
import { Text } from '@/components/StyledText';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
export function FileReferencePill() {
    const workspace = useFileWorkspace();
    const { theme } = useUnistyles();
    if (!workspace?.reference) return null;
    return <View style={{ flexDirection: 'row', alignItems: 'center', padding: 5 }}>
        <Button label={'@ ' + workspace.reference.path.split('/').pop()} icon="document-text-outline" onPress={() => { if (workspace.reference) void workspace.openReference(workspace.reference.path); }} selected />
        {workspace.reference.quote && <Text numberOfLines={1} style={{ flex: 1, maxWidth: 180, fontSize: 12, color: theme.colors.textSecondary }}>“{workspace.reference.quote}”</Text>}
        <Button label={t('fileWorkspace.removeReference')} icon="close-outline" compact onPress={() => workspace.setReference(null)} />
    </View>;
}
