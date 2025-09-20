import React from 'react';
import { View, Text, Platform, Pressable } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';

export interface DaemonCleanupModalProps {
  machineName: string;
  error: string;
  onRemoveSession: () => Promise<void>;
  onCancel: () => void;
  onForceStop: () => Promise<void>;
  onShow?: () => void;
  onHide?: () => void;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    padding: 20,
    backgroundColor: theme.colors.surface,
    borderRadius: 12,
    margin: 20,
    maxWidth: 400,
    alignSelf: 'center',
  },
  title: {
    ...Typography.default('semiBold'),
    fontSize: 18,
    color: theme.colors.text,
    marginBottom: 12,
    textAlign: 'center',
  },
  description: {
    ...Typography.default(),
    fontSize: 16,
    color: theme.colors.text,
    marginBottom: 16,
    lineHeight: 22,
  },
  errorText: {
    ...Typography.default(),
    fontSize: 14,
    color: theme.colors.textDestructive,
    backgroundColor: theme.colors.surfaceHigh,
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  optionsTitle: {
    ...Typography.default('semiBold'),
    fontSize: 16,
    color: theme.colors.text,
    marginBottom: 12,
  },
  option: {
    ...Typography.default(),
    fontSize: 15,
    color: theme.colors.text,
    marginBottom: 8,
    lineHeight: 20,
  },
  optionBullet: {
    color: theme.colors.textSecondary,
    marginRight: 8,
  },
  buttonContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 20,
    gap: 12,
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  cancelButton: {
    backgroundColor: theme.colors.surfaceHigh,
  },
  forceButton: {
    backgroundColor: theme.colors.warning || '#FF9500',
  },
  removeButton: {
    backgroundColor: theme.colors.textDestructive,
  },
  buttonText: {
    ...Typography.default('semiBold'),
    fontSize: 16,
  },
  cancelButtonText: {
    color: theme.colors.text,
  },
  forceButtonText: {
    color: '#FFFFFF',
  },
  removeButtonText: {
    color: '#FFFFFF',
  },
}));

export function showDaemonCleanupModal(props: DaemonCleanupModalProps): void {
  props.onShow?.();

  const handleRemoveSession = async () => {
    try {
      await props.onRemoveSession();
      props.onHide?.();
    } catch (error) {
      console.error('Failed to remove session:', error);
      Modal.alert(
        t('common.error'),
        error instanceof Error ? error.message : 'Failed to remove session',
      );
    }
  };

  const handleForceStop = async () => {
    try {
      await props.onForceStop();
      props.onHide?.();
    } catch (error) {
      console.error('Failed to force stop daemon:', error);
      Modal.alert(
        t('common.error'),
        error instanceof Error ? error.message : 'Failed to force stop daemon',
      );
    }
  };

  const description = `${t('daemonCleanup.couldNotStop', { machineName: props.machineName })}\n\n${t('daemonCleanup.error', { error: props.error })}\n\n${t('daemonCleanup.whatToDo')}`;

  Modal.alert(
    t('daemonCleanup.unableToStop'),
    description,
    [
      {
        text: t('common.cancel'),
        style: 'cancel',
        onPress: props.onCancel,
      },
      {
        text: t('daemonCleanup.forceStop'),
        style: 'default',
        onPress: handleForceStop,
      },
      {
        text: t('daemonCleanup.removeSession'),
        style: 'destructive',
        onPress: handleRemoveSession,
      },
    ],
  );
}

// Note: Using Modal.alert for simplicity and reliability across platforms.
// A custom modal component was previously used, but was removed due to complex TypeScript typing issues
// (e.g., difficulty typing modal props and lifecycle events in a way compatible with our codebase and Modal API).
// If a custom modal is needed in the future, consider defining a well-typed interface for modal props and handlers,
// or refactoring the modal logic to better align with TypeScript's type system.
// For now, Modal.alert provides a straightforward, type-safe solution.

export const DaemonCleanupModal = {
  show: showDaemonCleanupModal,
};

export default DaemonCleanupModal;