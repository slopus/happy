/**
 * CLI Management Component
 * Handles CLI version updates, dev branch switching, and version management
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useState, useCallback } from 'react';

import { Item } from './Item';
import { ItemGroup } from './ItemGroup';

import { Modal } from '@/modal';
import { sessionBash } from '@/sync/ops';
import { Session } from '@/sync/storageTypes';
import { t } from '@/text';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/versionUtils';

interface CliManagementProps {
    session: Session;
}

export function CliManagement({ session }: CliManagementProps) {
  const router = useRouter();
  const [isUpdating, setIsUpdating] = useState(false);
  const [isSwitchingBranch, setIsSwitchingBranch] = useState(false);

  // Check if CLI version is outdated
  const isCliOutdated = session.metadata?.version && !isVersionSupported(session.metadata.version, MINIMUM_CLI_VERSION);

  // Detect if user is on dev branch (check if CLI was installed from git)
  const isOnDevBranch = session.metadata?.version?.includes('git') ||
                         session.metadata?.version?.includes('dev') ||
                         session.metadata?.version?.includes('jefferson') ||
                         false;

  const handleStableUpdate = useCallback(async () => {
    setIsUpdating(true);

    try {
      // Run the stable update command remotely
      const result = await sessionBash(session.id, {
        command: 'npm install -g happy-coder@latest',
        timeout: 120000, // 2 minutes timeout
      });

      if (result.success) {
        Modal.alert(
          t('common.success'),
          t('sessionInfo.updateCliSuccess'),
          [
            {
              text: t('common.ok'),
              onPress: () => {
                router.replace(`/session/${session.id}`);
              },
            },
          ],
        );
      } else {
        Modal.alert(
          t('common.error'),
          `${t('sessionInfo.updateCliError')}\n\nError: ${result.stderr || result.error || 'Unknown error'}`,
        );
      }
    } catch (error) {
      Modal.alert(
        t('common.error'),
        `${t('sessionInfo.updateCliError')}\n\nError: ${String(error)}`,
      );
    } finally {
      setIsUpdating(false);
    }
  }, [session, router]);

  const handleDevBranchSwitch = useCallback(async () => {
    setIsSwitchingBranch(true);

    try {
      // Command to install from dev branch
      const devCommand = 'npm install -g git+https://github.com/jeffersonwarrior/happy-fork.git#main';

      const result = await sessionBash(session.id, {
        command: devCommand,
        timeout: 180000, // 3 minutes timeout for git clone
      });

      if (result.success) {
        Modal.alert(
          t('common.success'),
          t('sessionInfo.updateCliDevSuccess'),
          [
            {
              text: t('common.ok'),
              onPress: () => {
                router.replace(`/session/${session.id}`);
              },
            },
          ],
        );
      } else {
        Modal.alert(
          t('common.error'),
          `${t('sessionInfo.updateCliError')}\n\nError: ${result.stderr || result.error || 'Unknown error'}`,
        );
      }
    } catch (error) {
      Modal.alert(
        t('common.error'),
        `${t('sessionInfo.updateCliError')}\n\nError: ${String(error)}`,
      );
    } finally {
      setIsSwitchingBranch(false);
    }
  }, [session, router]);

  const handleStableBranchSwitch = useCallback(async () => {
    setIsSwitchingBranch(true);

    try {
      // First uninstall any git-based installation, then install stable
      const commands = [
        'npm uninstall -g happy-coder',
        'npm install -g happy-coder@latest',
      ];

      for (const command of commands) {
        const result = await sessionBash(session.id, {
          command,
          timeout: 120000,
        });

        if (!result.success && command.includes('uninstall')) {
          // Continue if uninstall fails (might not be installed)
          continue;
        }

        if (!result.success) {
          throw new Error(result.stderr || result.error || 'Command failed');
        }
      }

      Modal.alert(
        t('common.success'),
        t('sessionInfo.updateCliSuccess'),
        [
          {
            text: t('common.ok'),
            onPress: () => {
              router.replace(`/session/${session.id}`);
            },
          },
        ],
      );
    } catch (error) {
      Modal.alert(
        t('common.error'),
        `${t('sessionInfo.updateCliError')}\n\nError: ${String(error)}`,
      );
    } finally {
      setIsSwitchingBranch(false);
    }
  }, [session, router]);

  // Don't render if no CLI metadata
  if (!session.metadata?.version) {
    return null;
  }

  return (
    <ItemGroup>
      {/* Current Branch Info */}
      <Item
        title={`CLI Version: ${session.metadata.version}`}
        subtitle={isOnDevBranch ? 'Development branch (jeffersonwarrior/happy-fork)' : 'Stable release (npm)'}
        icon={<Ionicons
          name={isOnDevBranch ? 'git-branch-outline' : 'cube-outline'}
          size={29}
          color={isOnDevBranch ? '#FF6B35' : '#007AFF'}
        />}
        showChevron={false}
      />

      {/* Stable Update (if outdated) */}
      {isCliOutdated && !isOnDevBranch && (
        <Item
          title={isUpdating ? t('sessionInfo.updateCliUpdating') : t('sessionInfo.updateCliAutomatic')}
          subtitle={isUpdating ? 'Please wait...' : `Update from v${session.metadata.version} to v${MINIMUM_CLI_VERSION}+`}
          icon={<Ionicons
            name={isUpdating ? 'refresh-outline' : 'download-outline'}
            size={29}
            color={isUpdating ? '#FF9500' : '#34C759'}
          />}
          showChevron={!isUpdating}
          onPress={isUpdating ? undefined : handleStableUpdate}
        />
      )}

      {/* Dev Branch Switch */}
      {!isOnDevBranch && (
        <Item
          title={isSwitchingBranch ? t('sessionInfo.updateCliDevUpdating') : t('sessionInfo.updateCliDev')}
          subtitle={isSwitchingBranch ? 'Installing from git...' : t('sessionInfo.updateCliDevDescription')}
          icon={<Ionicons
            name={isSwitchingBranch ? 'refresh-outline' : 'git-branch-outline'}
            size={29}
            color={isSwitchingBranch ? '#FF9500' : '#FF6B35'}
          />}
          showChevron={!isSwitchingBranch}
          onPress={isSwitchingBranch ? undefined : handleDevBranchSwitch}
        />
      )}

      {/* Stable Branch Switch (if on dev) */}
      {isOnDevBranch && (
        <Item
          title={isSwitchingBranch ? 'Switching to stable...' : t('sessionInfo.updateCliStable')}
          subtitle={isSwitchingBranch ? 'Installing from npm...' : t('sessionInfo.updateCliStableDescription')}
          icon={<Ionicons
            name={isSwitchingBranch ? 'refresh-outline' : 'cube-outline'}
            size={29}
            color={isSwitchingBranch ? '#FF9500' : '#007AFF'}
          />}
          showChevron={!isSwitchingBranch}
          onPress={isSwitchingBranch ? undefined : handleStableBranchSwitch}
        />
      )}

      {/* Dev Branch Update (if on dev and want to pull latest) */}
      {isOnDevBranch && (
        <Item
          title="Update Dev Branch"
          subtitle="Pull latest changes from jeffersonwarrior/happy-fork"
          icon={<Ionicons name="refresh-outline" size={29} color="#FF6B35" />}
          showChevron={true}
          onPress={handleDevBranchSwitch}
        />
      )}
    </ItemGroup>
  );
}