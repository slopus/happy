import * as React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from './_all';
import { ToolSectionView } from '../ToolSectionView';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { Modal } from '@/modal';
import { t } from '@/text';

type HistoryPreviewItem = { role?: string; text?: string };

function asPreviewList(input: unknown): HistoryPreviewItem[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((v) => v && typeof v === 'object')
    .map((v) => {
      const obj = v as any;
      return {
        role: typeof obj.role === 'string' ? obj.role : undefined,
        text: typeof obj.text === 'string' ? obj.text : undefined,
      };
    });
}

export const AcpHistoryImportView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
  const { theme } = useUnistyles();
  const [loading, setLoading] = React.useState<'import' | 'skip' | null>(null);

  if (!sessionId) return null;
  const permissionId = tool.permission?.id;
  if (!permissionId) return null;

  const input = tool.input as any;
  const provider = typeof input?.provider === 'string' ? input.provider : 'acp';
  const remoteSessionId = typeof input?.remoteSessionId === 'string' ? input.remoteSessionId : undefined;
  const localCount = typeof input?.localCount === 'number' ? input.localCount : undefined;
  const remoteCount = typeof input?.remoteCount === 'number' ? input.remoteCount : undefined;
  const localTail = asPreviewList(input?.localTail);
  const remoteTail = asPreviewList(input?.remoteTail);
  const note = typeof input?.note === 'string' ? input.note : undefined;

  const isPending = tool.permission?.status === 'pending';

  const onImport = async () => {
    if (!isPending || loading) return;
    setLoading('import');
    try {
      await sessionAllow(sessionId, permissionId);
    } catch (e) {
      Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
    } finally {
      setLoading(null);
    }
  };

  const onSkip = async () => {
    if (!isPending || loading) return;
    setLoading('skip');
    try {
      await sessionDeny(sessionId, permissionId, undefined, undefined, 'denied');
    } catch (e) {
      Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
    } finally {
      setLoading(null);
    }
  };

  return (
    <ToolSectionView>
      <View style={styles.container}>
        <Text style={styles.title}>Import session history?</Text>
        <Text style={styles.subtitle}>
          {provider}{remoteSessionId ? ` • ${remoteSessionId}` : ''}
        </Text>
        <Text style={styles.body}>
          {note ?? 'This session history differs from what is already in Happy. Importing may create duplicates.'}
        </Text>

        {(typeof localCount === 'number' || typeof remoteCount === 'number') && (
          <View style={styles.countRow}>
            {typeof localCount === 'number' && <Text style={styles.countText}>Local: {localCount}</Text>}
            {typeof remoteCount === 'number' && <Text style={styles.countText}>Remote: {remoteCount}</Text>}
          </View>
        )}

        {(localTail.length > 0 || remoteTail.length > 0) && (
          <View style={styles.previewContainer}>
            {localTail.length > 0 && (
              <View style={styles.previewBlock}>
                <Text style={styles.previewHeader}>Local (tail)</Text>
                {localTail.map((m, idx) => (
                  <Text key={idx} style={styles.previewLine} numberOfLines={2}>
                    {(m.role ?? 'unknown')}: {m.text ?? ''}
                  </Text>
                ))}
              </View>
            )}
            {remoteTail.length > 0 && (
              <View style={styles.previewBlock}>
                <Text style={styles.previewHeader}>Remote (tail)</Text>
                {remoteTail.map((m, idx) => (
                  <Text key={idx} style={styles.previewLine} numberOfLines={2}>
                    {(m.role ?? 'unknown')}: {m.text ?? ''}
                  </Text>
                ))}
              </View>
            )}
          </View>
        )}

        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.button, styles.primaryButton, !isPending && styles.disabled]}
            disabled={!isPending || loading !== null}
            onPress={onImport}
          >
            {loading === 'import' ? <ActivityIndicator color={theme.colors.button.primary.tint} /> : <Text style={styles.primaryText}>Import</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.button, styles.secondaryButton, !isPending && styles.disabled]}
            disabled={!isPending || loading !== null}
            onPress={onSkip}
          >
            {loading === 'skip' ? <ActivityIndicator color={theme.colors.text} /> : <Text style={styles.secondaryText}>Skip</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </ToolSectionView>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: 10,
    paddingVertical: 4,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.colors.text,
  },
  subtitle: {
    fontSize: 12,
    color: theme.colors.textSecondary,
  },
  body: {
    fontSize: 13,
    color: theme.colors.text,
    lineHeight: 18,
  },
  countRow: {
    flexDirection: 'row',
    gap: 12,
  },
  countText: {
    fontSize: 12,
    color: theme.colors.textSecondary,
  },
  previewContainer: {
    gap: 10,
  },
  previewBlock: {
    gap: 6,
    padding: 10,
    borderRadius: 8,
    backgroundColor: theme.colors.surfaceHighest,
  },
  previewHeader: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.colors.textSecondary,
    textTransform: 'uppercase',
  },
  previewLine: {
    fontSize: 12,
    color: theme.colors.text,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  primaryButton: {
    backgroundColor: theme.colors.button.primary.background,
  },
  primaryText: {
    color: theme.colors.button.primary.tint,
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: theme.colors.surfaceHigh,
    borderWidth: 1,
    borderColor: theme.colors.divider,
  },
  secondaryText: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  disabled: {
    opacity: 0.5,
  },
}));

