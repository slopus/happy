import { GitHubProfile } from "./app/api/types";
import { ImageRef } from "./storage/files";

export type AccountProfile = {
    firstName: string | null;
    lastName: string | null;
    avatar: ImageRef | null;
    github: GitHubProfile | null;
    settings: {
        value: string | null;
        version: number;
    } | null;
    connectedServices: string[];
}