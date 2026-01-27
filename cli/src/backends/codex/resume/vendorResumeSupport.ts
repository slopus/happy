import type { VendorResumeSupportFn } from '@/backends/types';

import { isExperimentalCodexAcpEnabled, isExperimentalCodexVendorResumeEnabled } from '@/backends/codex/experiments';

export const supportsCodexVendorResume: VendorResumeSupportFn = (params) => {
  return params.experimentalCodexResume === true
    || params.experimentalCodexAcp === true
    || isExperimentalCodexVendorResumeEnabled()
    || isExperimentalCodexAcpEnabled();
};

