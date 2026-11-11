import * as React from 'react';
import { Text } from 'react-native';
import type { FileDocument } from './controller';
import { t } from '@/text';

export function WorkspaceMediaPreview(_props: { media: NonNullable<FileDocument['media']>; name: string }) {
    return <Text>{t('fileWorkspace.unsupported')}</Text>;
}
