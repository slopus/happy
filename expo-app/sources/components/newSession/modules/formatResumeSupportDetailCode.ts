import { t } from '@/text';

export type ResumeSupportDetailCode = 'cliNotDetected' | 'capabilityProbeFailed' | 'acpProbeFailed' | 'loadSessionFalse';

export function formatResumeSupportDetailCode(code: ResumeSupportDetailCode): string {
    switch (code) {
        case 'cliNotDetected':
            return t('session.resumeSupportDetails.cliNotDetected');
        case 'capabilityProbeFailed':
            return t('session.resumeSupportDetails.capabilityProbeFailed');
        case 'acpProbeFailed':
            return t('session.resumeSupportDetails.acpProbeFailed');
        case 'loadSessionFalse':
            return t('session.resumeSupportDetails.loadSessionFalse');
    }
}

