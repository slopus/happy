package com.slopus.happy.ui.home

import com.slopus.happy.model.Machine
import com.slopus.happy.model.Session
import com.slopus.happy.model.forkSource
import com.slopus.happy.model.isRig

/** Why resume is offered but can't run, or null when it can (useSessionQuickActions getResumeAvailability). */
enum class ResumeBlock { MissingMachine, MissingBackendId, SameMachineOnly, MachineOffline }

data class ResumeAvailability(val canResume: Boolean, val canShowResume: Boolean, val block: ResumeBlock?) {
    companion object {
        val Hidden = ResumeAvailability(canResume = false, canShowResume = false, block = null)
        fun blocked(block: ResumeBlock) = ResumeAvailability(canResume = false, canShowResume = true, block = block)
    }
}

/**
 * Resume is for a Happy CLI session that is no longer connected. It shows,
 * greyed with a reason, when something is missing; it hides entirely for Rig,
 * for an opted-out session, and for a daemon that doesn't publish the RPC.
 */
fun resumeAvailability(session: Session, machine: Machine?): ResumeAvailability {
    val metadata = session.metadata
    if (metadata.isRig() || metadata?.capabilities?.resume == false) return ResumeAvailability.Hidden
    if (session.isOnline) return ResumeAvailability.Hidden
    if (metadata?.machineId.isNullOrEmpty()) return ResumeAvailability.blocked(ResumeBlock.MissingMachine)
    if (metadata.claudeSessionId.isNullOrEmpty() && metadata.codexThreadId.isNullOrEmpty()) {
        return ResumeAvailability.blocked(ResumeBlock.MissingBackendId)
    }
    if (machine == null) return ResumeAvailability.blocked(ResumeBlock.SameMachineOnly)
    if (!machine.isOnline) return ResumeAvailability.blocked(ResumeBlock.MachineOffline)
    if (machine.metadata?.resumeSupport?.rpcAvailable != true) return ResumeAvailability.Hidden
    return ResumeAvailability(canResume = true, canShowResume = true, block = null)
}

/** Fork and duplicate: the experiment on, a Happy CLI session with a fork source, its machine online. */
fun canForkSession(session: Session, machine: Machine?, continuationExperiments: Boolean): Boolean =
    continuationExperiments && !session.metadata.isRig() && session.forkSource() != null && machine?.isOnline == true

/** The "Session" alert's rows, in order (useSessionQuickActions actionItems). */
enum class SessionActionId { Details, Resume, Fork, Duplicate, CopyMetadata, CopyMetadataAndLogs, Archive }

fun sessionActionIds(session: Session, machine: Machine?, continuationExperiments: Boolean, devMode: Boolean): List<SessionActionId> = buildList {
    add(SessionActionId.Details)
    if (resumeAvailability(session, machine).canShowResume) add(SessionActionId.Resume)
    if (canForkSession(session, machine, continuationExperiments)) {
        add(SessionActionId.Fork)
        add(SessionActionId.Duplicate)
    }
    if (devMode) {
        add(SessionActionId.CopyMetadata)
        add(SessionActionId.CopyMetadataAndLogs)
    }
    add(SessionActionId.Archive)
}
