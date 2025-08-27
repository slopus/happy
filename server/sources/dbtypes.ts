import { GitHubProfile as GitHubProfileType, GitHubOrg as GitHubOrgType } from "./app/types";

declare global {
    namespace PrismaJson {
        type GitHubProfile = GitHubProfileType;
        type GitHubOrg = GitHubOrgType;
    }
}