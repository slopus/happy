import type { DecryptedArtifact } from '../../artifactTypes';
import type { StoreGet, StoreSet } from './_shared';

export type ArtifactsDomain = {
  artifacts: Record<string, DecryptedArtifact>;
  applyArtifacts: (artifacts: DecryptedArtifact[]) => void;
  addArtifact: (artifact: DecryptedArtifact) => void;
  updateArtifact: (artifact: DecryptedArtifact) => void;
  deleteArtifact: (artifactId: string) => void;
};

export function createArtifactsDomain<S extends ArtifactsDomain>({
  set,
}: {
  set: StoreSet<S>;
  get: StoreGet<S>;
}): ArtifactsDomain {
  return {
    artifacts: {},
    applyArtifacts: (artifacts) =>
      set((state) => {
        const mergedArtifacts = { ...state.artifacts };
        artifacts.forEach((artifact) => {
          mergedArtifacts[artifact.id] = artifact;
        });

        return {
          ...state,
          artifacts: mergedArtifacts,
        };
      }),
    addArtifact: (artifact) =>
      set((state) => {
        const updatedArtifacts = {
          ...state.artifacts,
          [artifact.id]: artifact,
        };

        return {
          ...state,
          artifacts: updatedArtifacts,
        };
      }),
    updateArtifact: (artifact) =>
      set((state) => {
        const updatedArtifacts = {
          ...state.artifacts,
          [artifact.id]: artifact,
        };

        return {
          ...state,
          artifacts: updatedArtifacts,
        };
      }),
    deleteArtifact: (artifactId) =>
      set((state) => {
        const { [artifactId]: _, ...remainingArtifacts } = state.artifacts;

        return {
          ...state,
          artifacts: remainingArtifacts,
        };
      }),
  };
}

