// AUTO-GENERATED FILE - DO NOT EDIT.
// Source: prisma/schema.prisma
// Regenerate: yarn schema:sync

export const RelationshipStatus = {
    none: "none",
    requested: "requested",
    pending: "pending",
    friend: "friend",
    rejected: "rejected",
} as const;

export type RelationshipStatus = (typeof RelationshipStatus)[keyof typeof RelationshipStatus];
