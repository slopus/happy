import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { getServerUrl } from './serverConfig';
import { Artifact, ArtifactCreateRequest, ArtifactUpdateRequest, ArtifactUpdateResponse } from './artifactTypes';

/**
 * Fetch all artifacts for the account
 */
export async function fetchArtifacts(credentials: AuthCredentials): Promise<Artifact[]> {
    const API_ENDPOINT = getServerUrl();

    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/artifacts`, {
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch artifacts: ${response.status}`);
        }

        const data = await response.json() as Artifact[];
        return data;
    });
}

/**
 * Fetch a single artifact with full body
 */
export async function fetchArtifact(credentials: AuthCredentials, artifactId: string): Promise<Artifact> {
    const API_ENDPOINT = getServerUrl();

    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/artifacts/${artifactId}`, {
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new Error('Artifact not found');
            }
            throw new Error(`Failed to fetch artifact: ${response.status}`);
        }

        const data = await response.json() as Artifact;
        return data;
    });
}

/**
 * Create a new artifact
 */
export async function createArtifact(
    credentials: AuthCredentials, 
    request: ArtifactCreateRequest
): Promise<Artifact> {
    const API_ENDPOINT = getServerUrl();

    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/artifacts`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(request)
        });

        if (!response.ok) {
            if (response.status === 409) {
                throw new Error('Artifact ID already exists');
            }
            throw new Error(`Failed to create artifact: ${response.status}`);
        }

        const data = await response.json() as Artifact;
        return data;
    });
}

/**
 * Update an existing artifact
 */
export async function updateArtifact(
    credentials: AuthCredentials,
    artifactId: string,
    request: ArtifactUpdateRequest
): Promise<ArtifactUpdateResponse> {
    const API_ENDPOINT = getServerUrl();

    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/artifacts/${artifactId}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(request)
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new Error('Artifact not found');
            }
            throw new Error(`Failed to update artifact: ${response.status}`);
        }

        const data = await response.json() as ArtifactUpdateResponse;
        return data;
    });
}

/**
 * Delete an artifact
 */
export async function deleteArtifact(
    credentials: AuthCredentials,
    artifactId: string
): Promise<void> {
    const API_ENDPOINT = getServerUrl();

    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/artifacts/${artifactId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${credentials.token}`
            }
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new Error('Artifact not found');
            }
            throw new Error(`Failed to delete artifact: ${response.status}`);
        }
    });
}