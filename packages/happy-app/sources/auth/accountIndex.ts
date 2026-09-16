import { MMKV } from 'react-native-mmkv';

// Non-secret account metadata. Native credentials live separately in SecureStore.
export const accountIndex = new MMKV({ id: 'paws-account-registry-v1' });
