import type { VendorResumeSupportFn } from '@/backends/types';

import { isExperimentalCodexAcpEnabled, isExperimentalCodexVendorResumeEnabled } from '@/codex/experiments';

export const supportsCodexVendorResume: VendorResumeSupportFn = (params) => {
  return params.experimentalCodexResume === true
    || params.experimentalCodexAcp === true
    || isExperimentalCodexVendorResumeEnabled()
    || isExperimentalCodexAcpEnabled();
};

