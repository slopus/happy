export function handleDeleteArtifactSocketUpdate(params: {
    artifactId: string;
    deleteArtifact: (artifactId: string) => void;
    artifactDataKeys: Map<string, Uint8Array>;
}): void {
    const { artifactId, deleteArtifact, artifactDataKeys } = params;

    // Remove from storage
    deleteArtifact(artifactId);

    // Remove encryption key from memory
    artifactDataKeys.delete(artifactId);
}

