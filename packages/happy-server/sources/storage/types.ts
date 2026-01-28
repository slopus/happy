import { GitHubProfile as GitHubProfileType, GitHubOrg as GitHubOrgType } from "../app/api/types";
import { ImageRef as ImageRefType } from "./files";
declare global {
    namespace PrismaJson {
        // Session message content types
        type SessionMessageContent = {
            t: 'encrypted';
            c: string; // Base64 encoded encrypted content
        };

        // Usage report data structure
        type UsageReportData = {
            tokens: {
                total: number;
                [key: string]: number;
            };
            cost: {
                total: number;
                [key: string]: number;
            };
        };

        // Update content types
        type UpdateBody = {
            t: 'new-message';
            sid: string;
            message: {
                id: string;
                seq: number;
                content: SessionMessageContent;
                localId: string | null;
                createdAt: number;
                updatedAt: number;
            }
        } | {
            t: 'new-session';
            id: string;
            seq: number;
            metadata: string;
            metadataVersion: number;
            agentState: string | null;
            agentStateVersion: number;
            dataEncryptionKey: string | null;
            active: boolean;
            activeAt: number;
            createdAt: number;
            updatedAt: number;
        } | {
            t: 'update-session'
            id: string;
            metadata?: {
                value: string | null;
                version: number;
            } | null | undefined
            agentState?: {
                value: string | null;
                version: number;
            } | null | undefined
        } | {
            t: 'update-account';
            id: string;
            settings?: {
                value: string | null;
                version: number;
            } | null | undefined;
            github?: GitHubProfileType | null | undefined;
        } | {
            t: 'new-machine';
            machineId: string;
            seq: number;
            metadata: string;
            metadataVersion: number;
            daemonState: string | null;
            daemonStateVersion: number;
            dataEncryptionKey: string | null;
            active: boolean;
            activeAt: number;
            createdAt: number;
            updatedAt: number;
        } | {
            t: 'update-machine';
            machineId: string;
            metadata?: {
                value: string;
                version: number;
            };
            daemonState?: {
                value: string;
                version: number;
            };
            activeAt?: number;
        };

        type GitHubProfile = GitHubProfileType;
        type GitHubOrg = GitHubOrgType;
        type ImageRef = ImageRefType;
    }
}

// The file MUST be a module! 
export { };