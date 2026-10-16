package com.slopus.happy.attachments

import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.isRigV1
import com.slopus.happy.sync.rigCanUseAttachments

// attachmentSupport.ts: which agents take images, and what a send does with
// attachments an agent can't take.

/** supportsImageAttachmentsForFlavor: sessions without a flavor, Claude and Codex. */
fun supportsImageAttachmentsForFlavor(flavor: String?): Boolean =
    flavor.isNullOrEmpty() || flavor == "claude" || flavor == "codex"

data class ImageAttachmentSendPlan(
    val supportsAttachments: Boolean,
    val shouldUseAttachments: Boolean,
    val shouldShowUnsupportedAlert: Boolean,
    val shouldSendText: Boolean,
)

/** getImageAttachmentSendPlan; [supportsAttachments] (rig capability metadata) overrides the flavor. */
fun imageAttachmentSendPlan(
    flavor: String?,
    text: String,
    attachmentCount: Int,
    supportsAttachments: Boolean? = null,
): ImageAttachmentSendPlan {
    val hasAttachments = attachmentCount > 0
    val supports = supportsAttachments ?: supportsImageAttachmentsForFlavor(flavor)
    val unsupportedAlert = hasAttachments && !supports
    return ImageAttachmentSendPlan(
        supportsAttachments = supports,
        shouldUseAttachments = hasAttachments && supports,
        shouldShowUnsupportedAlert = unsupportedAlert,
        shouldSendText = !unsupportedAlert || text.trim().isNotEmpty(),
    )
}

/** A rig's attachment limits (`capabilities.attachments`). */
data class AttachmentPolicy(val maxBytes: Double, val mediaTypes: List<String>)

/** isAttachmentAllowedByPolicy: an unknown size (0) passes; a `type/` wildcard matches any subtype. */
fun isAttachmentAllowedByPolicy(mimeType: String, size: Long, policy: AttachmentPolicy): Boolean {
    val sizeAllowed = size <= 0 || size <= policy.maxBytes
    val mediaAllowed = policy.mediaTypes.any { allowed ->
        allowed == mimeType || (allowed.endsWith("/*") && mimeType.startsWith(allowed.dropLast(1)))
    }
    return sizeAllowed && mediaAllowed
}

/** sync.ts sendMessage: the plan for [metadata]'s session, with the rig policy where there is one. */
fun imageAttachmentSendPlan(metadata: SessionMetadata?, text: String, attachmentCount: Int) = imageAttachmentSendPlan(
    flavor = metadata?.flavor,
    text = text,
    attachmentCount = attachmentCount,
    supportsAttachments = if (metadata.isRigV1()) metadata.rigCanUseAttachments() else null,
)

/** The rig's policy, for rig v1 sessions only. */
fun SessionMetadata?.rigAttachmentPolicy(): AttachmentPolicy? {
    if (!isRigV1()) return null
    val capabilities = this?.capabilities ?: return null
    return AttachmentPolicy(capabilities.attachmentsMaxBytes, capabilities.attachmentsMediaTypes)
}
