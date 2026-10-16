package com.slopus.happy.model

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

// sessionAvatarTypes.ts and the avatar half of sync.ts applySessions.

/** sessionAvatarTypes.ts `SessionAvatarDescriptor`: an opaque ref and a preview sealed with the session key. */
@Immutable
data class SessionAvatarDescriptor(val ref: String, val preview: String, val version: Long) {
    fun toJson(): JsonObject = JsonObject(mapOf("ref" to JsonPrimitive(ref), "preview" to JsonPrimitive(preview), "version" to JsonPrimitive(version)))

    companion object {
        /** sessionAvatarDescriptorSchema: ref 1..1024, preview 1..4096, a positive integer version; anything else is none. */
        fun parse(value: JsonElement?): SessionAvatarDescriptor? {
            val json = value as? JsonObject ?: return null
            val ref = (json["ref"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.length in 1..1024 } ?: return null
            val preview = (json["preview"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.length in 1..4096 } ?: return null
            val version = (json["version"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it > 0 } ?: return null
            return SessionAvatarDescriptor(ref, preview, version)
        }

        fun parse(text: String?): SessionAvatarDescriptor? = parse(parseJsonObject(text))
    }
}

/** sessionAvatarRevisionSchema: a non-negative integer. */
fun parseSessionAvatarRevision(value: JsonElement?): Long? =
    (value as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it >= 0 }

/** A session's avatar as the store keeps it: the descriptor and what says how new it is. */
data class StoredSessionAvatar(
    val descriptorJson: String?,
    /** `avatarVersion` (or the descriptor's version) as the server numbered it. */
    val revision: Long?,
    /** The seq of the live update that last set it; null when a listing did. */
    val updateSeq: Long?,
)

/**
 * sync.ts's avatar rule for two sources. A live update replaces the
 * stored avatar when its revision is higher, or (without two revisions to
 * compare) when its update seq is later than the last live one. A listing
 * is the server's snapshot and replaces it unless the stored revision is
 * higher; without two revisions, unless a live update set it more
 * recently than the listed record changed ([listingIsNewer]).
 */
fun mergeSessionAvatar(existing: StoredSessionAvatar, incoming: StoredSessionAvatar, listingIsNewer: Boolean): StoredSessionAvatar {
    if (incoming == existing) return existing
    val live = incoming.updateSeq != null && incoming.updateSeq != existing.updateSeq
    val bothRevised = incoming.revision != null && existing.revision != null
    val replaces = if (live) {
        if (bothRevised) incoming.revision!! > existing.revision!! else incoming.updateSeq!! > (existing.updateSeq ?: -1)
    } else {
        if (bothRevised) incoming.revision!! >= existing.revision!! else existing.updateSeq == null || listingIsNewer
    }
    if (!replaces) return existing
    return StoredSessionAvatar(incoming.descriptorJson, incoming.revision, if (live) incoming.updateSeq else existing.updateSeq)
}
