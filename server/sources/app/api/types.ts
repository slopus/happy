import { FastifyBaseLogger, FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { IncomingMessage, Server, ServerResponse } from "http";

export interface GitHubProfile {
    id: number;
    login: string;
    type: string;
    site_admin: boolean;
    avatar_url: string;
    gravatar_id: string | null;
    name: string | null;
    company: string | null;
    blog: string | null;
    location: string | null;
    email: string | null;
    hireable: boolean | null;
    bio: string | null;
    twitter_username: string | null;
    public_repos: number;
    public_gists: number;
    followers: number;
    following: number;
    created_at: string;
    updated_at: string;
    // Private user fields (only available when authenticated)
    private_gists?: number;
    total_private_repos?: number;
    owned_private_repos?: number;
    disk_usage?: number;
    collaborators?: number;
    two_factor_authentication?: boolean;
    plan?: {
        collaborators: number;
        name: string;
        space: number;
        private_repos: number;
    };
}

export interface GitHubOrg {

}

export type Fastify = FastifyInstance<
    Server<typeof IncomingMessage, typeof ServerResponse>,
    IncomingMessage,
    ServerResponse<IncomingMessage>,
    FastifyBaseLogger,
    ZodTypeProvider
>;

declare module 'fastify' {
    interface FastifyRequest {
        userId: string;
        startTime?: number;
    }
    interface FastifyInstance {
        authenticate: any;
    }
}