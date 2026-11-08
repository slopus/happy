import * as React from 'react';
import { Text } from '@/components/StyledText';
import { t } from '@/text';
export function HtmlFilePreview(_props: { sessionId: string; path: string; content: string; root: string; revision?: number; readBytes?: (path: string) => Promise<Uint8Array>; onReady?: (ready: boolean) => void }) { return <Text>{t('fileWorkspace.unsupported')}</Text>; }
