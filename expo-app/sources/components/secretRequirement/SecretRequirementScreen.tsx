import React from 'react';
import type { SecretRequirementModalProps } from './SecretRequirementModal';
import { SecretRequirementModal } from './SecretRequirementModal';

export type SecretRequirementScreenProps = SecretRequirementModalProps;

export function SecretRequirementScreen(props: SecretRequirementScreenProps) {
    return <SecretRequirementModal {...props} layoutVariant="screen" />;
}

