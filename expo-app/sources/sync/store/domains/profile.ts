import type { Profile } from '../../profile';
import { loadProfile, saveProfile } from '../../persistence';

import type { StoreGet, StoreSet } from './_shared';

export type ProfileDomain = {
    profile: Profile;
    applyProfile: (profile: Profile) => void;
};

export function createProfileDomain<S extends ProfileDomain>({
    set,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): ProfileDomain {
    const profile = loadProfile();

    return {
        profile,
        applyProfile: (nextProfile) =>
            set((state) => {
                saveProfile(nextProfile);
                return {
                    ...state,
                    profile: nextProfile,
                };
            }),
    };
}

