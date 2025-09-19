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