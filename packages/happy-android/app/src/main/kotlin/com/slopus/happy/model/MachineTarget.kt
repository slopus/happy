package com.slopus.happy.model

import androidx.compose.runtime.Immutable

// happy-ios MachineTarget.swift (7d4ed9797, 9e58785b4): where a compose
// chat's first send can go, and for which kind of work.

/** What a compose chat's first send makes (happy-ios `HomeDockKind`). */
enum class ComposeKind { Session, Bot, Task }

/**
 * One computer as the compose chat's computer menu lists it: whether it
 * answers, what its Happy Agent makes, and when it was last seen. A bot or
 * a task is made by Happy Agent, so for those "online" means that Happy
 * Agent answers; a session can start on any computer.
 */
@Immutable
data class MachineTarget(
    /** [MachineChoice.id]. */
    val id: String,
    val name: String,
    /** Some daemon on it answers. */
    val online: Boolean,
    /** Its Happy Agent answers. */
    val happyAgentOnline: Boolean,
    val makesBots: Boolean,
    val makesTasks: Boolean,
    /** When something on it last answered; 0 while it answers. */
    val lastSeenAt: Long,
    /** When its Happy Agent last answered; 0 while it does, or without one. */
    val happyAgentLastSeenAt: Long = 0,
) {
    fun makes(kind: ComposeKind): Boolean = when (kind) {
        ComposeKind.Session -> true
        ComposeKind.Bot -> makesBots
        ComposeKind.Task -> makesTasks
    }

    /** Any daemon for a session, Happy Agent for a bot or a task. */
    fun isOnline(kind: ComposeKind): Boolean = if (kind == ComposeKind.Session) online else happyAgentOnline

    /** When what [kind] needs here last answered; null while it answers or when never seen. */
    fun lastSeen(kind: ComposeKind): Long? {
        if (isOnline(kind)) return null
        val at = if (kind == ComposeKind.Session) lastSeenAt else happyAgentLastSeenAt
        return at.takeIf { it > 0 }
    }

    companion object {
        fun of(choice: MachineChoice): MachineTarget {
            val agent = choice.rigMachine
            val rig = agent?.metadata?.rigSessionCreation()
            return MachineTarget(
                id = choice.id,
                name = choice.name,
                online = choice.online,
                happyAgentOnline = agent?.isOnline == true,
                makesBots = rig?.supportsBots == true,
                makesTasks = rig?.supportsTasks == true,
                lastSeenAt = if (choice.online) 0 else choice.activeAt,
                happyAgentLastSeenAt = if (agent != null && !agent.isOnline) agent.activeAt else 0,
            )
        }

        /** The computers that can make [kind], those that answer for it first, each group in [targets]' order. */
        fun eligible(targets: List<MachineTarget>, kind: ComposeKind): List<MachineTarget> {
            val able = targets.filter { it.makes(kind) }
            return able.filter { it.isOnline(kind) } + able.filterNot { it.isOnline(kind) }
        }

        /**
         * Where [kind] goes when it is picked: the [current] computer if it
         * makes it and answers for it; else the first that does; else, all
         * offline, the current one if it can make it, then the first that
         * can. Null when no computer can make [kind].
         */
        fun preferred(targets: List<MachineTarget>, kind: ComposeKind, current: String?): MachineTarget? {
            val able = eligible(targets, kind)
            val chosen = able.find { it.id == current }
            if (chosen != null && chosen.isOnline(kind)) return chosen
            return able.find { it.isOnline(kind) } ?: chosen ?: able.firstOrNull()
        }
    }
}

/** Why the first send can't reach the chosen computer now (happy-ios `NewSessionChoices.Offline`). */
@Immutable
sealed interface ComposeOffline {
    /** Nothing on the computer answers; last seen at [lastSeenAt] (ms). */
    data class Computer(val lastSeenAt: Long) : ComposeOffline

    /** The computer answers, but its Happy Agent, which a bot, a task or the Happy harness needs, does not. */
    data object HappyAgent : ComposeOffline

    /** The computer answers, but its Happy CLI, which the harness needs, does not. */
    data object HappyCli : ComposeOffline
}
