package com.slopus.happy.onboarding

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.chat.strings
import kotlinx.serialization.json.JsonObject

/**
 * `GET /v0/onboarding` on a Happy Cloud server (T09's contract v6): the
 * gates it holds the person to, in the order the flow shows them. Gates are
 * read live and nothing latches: a gate made required later blocks again
 * and [finished] turns false. [finished] is the server's: nothing blocks
 * the person and no optional gate is still open for them to take.
 */
data class CloudOnboarding(
    val finished: Boolean,
    /** The IDs of the gates that block the person. */
    val blocking: List<String> = emptyList(),
    val gates: List<OnboardingGate> = emptyList(),
    /** The team's owners, named on "waiting for your admin". */
    val owners: List<String> = emptyList(),
    /** Read from a server without gates ([parse]): no flow at all. */
    val legacy: Boolean = false,
) {
    fun gate(id: String): OnboardingGate? = gates.firstOrNull { it.id == id }

    companion object {
        /**
         * The events after which it is read again; the app coming back to
         * the foreground reads it too (a sign-in on another phone sends nothing).
         */
        val REFRESH_EVENTS = setOf(
            "onboarding.updated", "profile.updated", "bot.updated", "config.updated", "plugins.changed",
            "invite.created", "member.updated", "member.removed",
        )

        fun parse(json: JsonObject): CloudOnboarding {
            // FALLBACK (servers deployed before gates): no `gates`, no flow. The
            // name is still asked at sign-in (profile_required), and home is as it
            // was. Delete once every server answers with gates.
            val gates = json["gates"].arr ?: return CloudOnboarding(finished = true, legacy = true)
            return CloudOnboarding(
                // v5: `finished`; a server before it says only `completed`.
                finished = json["finished"].bool ?: json["completed"].bool ?: false,
                blocking = json["blocking"].strings.orEmpty(),
                gates = gates.mapNotNull { it.obj?.let(OnboardingGate::parse) },
                owners = json["owners"].arr.orEmpty().mapNotNull { it.obj?.get("name").str?.takeIf(String::isNotBlank) },
            )
        }
    }
}

/** One step the server holds the person to. */
data class OnboardingGate(
    val id: String,
    val scope: Scope = Scope.Member,
    val requirement: Requirement = Requirement.Optional,
    val status: Status = Status.Open,
    /** The server's: required, and open or not yet able to be told. */
    val blocking: Boolean = requirement == Requirement.Required && (status == Status.Open || status == Status.Unavailable),
    /** Whether the person's role lets them complete it. */
    val canComplete: Boolean = true,
    val kind: Kind,
) {
    enum class Scope { Member, Server }
    enum class Requirement { Optional, Required }
    enum class Status { Done, Open, Skipped, Unavailable }

    /** What the gate asks, with what its screen needs. [Kind.Unknown]: one this app can't show (newer, or unreadable). */
    sealed interface Kind {
        data object Profile : Kind
        data object Avatar : Kind
        /** The Chief of Staff and the server's words for it; [version] goes in `If-Match` when it is renamed. */
        data class AdminBot(
            val botId: String,
            val agentId: String?,
            val name: String,
            val version: String?,
            val title: String?,
            val points: List<String>,
            val note: String?,
            val description: String?,
            /** Its picture as the server serves it (`/v0/bots/:id/avatar`) and its ThumbHash; null where it has none. */
            val picture: String? = null,
            val thumbhash: String? = null,
        ) : Kind
        /** [connected]: the team's or the person's own providers; [freeModel]: the operator's free model runs meanwhile. */
        data class Inference(val connected: List<String>, val freeModel: Boolean) : Kind
        /** The plugins asked for; with none required, any one active completes it. */
        data class Plugins(val required: List<String>, val plugins: List<Plugin>) : Kind {
            data class Plugin(val id: String, val name: String, val required: Boolean, val active: Boolean)
        }
        data class Teammates(val invited: Boolean, val members: Int) : Kind
        /** [registered]: a live push registration from a phone. */
        data class MobileApp(val registered: Boolean, val appStoreUrl: String?, val playStoreUrl: String?) : Kind
        /** Payments are set up on desktop or the web; the phone sends people there. */
        data object PaymentMethod : Kind
        data object Payment : Kind
        data object Unknown : Kind
    }

    /** Still the person's to see to: it blocks them, or it is optional, open, and theirs to take. */
    val pending: Boolean get() = blocking || (requirement == Requirement.Optional && status == Status.Open && canComplete)

    /** One the person can see to on this phone now: theirs to complete, known here, and one the server can tell. */
    val actionable: Boolean get() = kind != Kind.Unknown && canComplete && status != Status.Unavailable

    companion object {
        fun parse(json: JsonObject): OnboardingGate? {
            val id = json["id"].str ?: return null
            val blocking = json["blocking"].bool ?: false
            val scope = when (json["scope"].str) { "member" -> Scope.Member; "server" -> Scope.Server; else -> null }
            val requirement = when (json["requirement"].str) { "optional" -> Requirement.Optional; "required" -> Requirement.Required; else -> null }
            val status = when (json["status"].str) {
                "done" -> Status.Done
                "open" -> Status.Open
                "skipped" -> Status.Skipped
                "unavailable" -> Status.Unavailable
                else -> null
            }
            val data = json["data"].obj ?: JsonObject(emptyMap())
            // A gate whose words this app doesn't know can't be shown; a blocking one still holds the person.
            val kind = if (scope == null || requirement == null || status == null) Kind.Unknown else kind(id, data)
            return OnboardingGate(
                id = id,
                scope = scope ?: Scope.Server,
                requirement = requirement ?: if (blocking) Requirement.Required else Requirement.Optional,
                status = status ?: if (blocking) Status.Open else Status.Unavailable,
                blocking = blocking,
                canComplete = json["canComplete"].bool ?: false,
                kind = kind,
            )
        }

        private fun kind(id: String, data: JsonObject): Kind = when (id) {
            "profile" -> Kind.Profile
            "avatar" -> Kind.Avatar
            "adminBot" -> data["botId"].str?.let { botId ->
                Kind.AdminBot(
                    botId = botId,
                    agentId = data["agentId"].str,
                    name = data["name"].str.orEmpty(),
                    version = data["version"].str,
                    title = data["title"].str,
                    points = data["points"].strings.orEmpty(),
                    note = data["note"].str,
                    description = data["description"].str,
                    picture = data["avatar"].obj?.let { "/v0/bots/${AgentClient.escape(botId)}/avatar" },
                    thumbhash = data["avatar"].obj?.get("thumbhash").str,
                )
            } ?: Kind.Unknown
            "inference" -> Kind.Inference(data["connected"].strings.orEmpty(), data["freeModel"].bool ?: false)
            "plugins" -> Kind.Plugins(
                data["required"].strings.orEmpty(),
                data["plugins"].arr.orEmpty().mapNotNull { it.obj }.mapNotNull { p ->
                    val pluginId = p["id"].str ?: return@mapNotNull null
                    Kind.Plugins.Plugin(pluginId, p["name"].str ?: pluginId, p["required"].bool ?: false, p["active"].bool ?: false)
                },
            )
            "teammates" -> Kind.Teammates(data["invited"].bool ?: false, data["members"].num?.toInt() ?: 1)
            "mobileApp" -> Kind.MobileApp(data["registered"].bool ?: false, data["appStoreUrl"].str, data["playStoreUrl"].str)
            "paymentMethod" -> Kind.PaymentMethod
            "payment" -> Kind.Payment
            else -> Kind.Unknown
        }
    }
}

/**
 * What the onboarding flow shows next, worked out from the gates alone, as
 * iOS's OnboardingPlan: the first gate the person can see to now, in the
 * server's order; once none is left, whatever still holds them; else the
 * finish. Each screen is read again from the server's answer.
 */
data class OnboardingPlan(
    /** Null once onboarding is finished (or on a server without gates). */
    val step: Step?,
    val legacy: Boolean,
    /** How many gates the flow walks through, done ones included. */
    val count: Int,
    /** How many of them are still the person's to see to. */
    val remaining: Int,
) {
    sealed interface Step {
        /** A screen for a gate the person can see to now. */
        data class Gate(val gate: OnboardingGate) : Step
        /** A gate this app can't show blocks the person: update the app. */
        data object Update : Step
        /** Blocking gates only someone else can see to, or the server can't tell yet. */
        data class Waiting(val gates: List<OnboardingGate>) : Step
        /** Nothing holds the person: finish (`POST /v0/onboarding/complete`). */
        data object Finish : Step
    }

    /** How far along the flow is, from 0 to 1. */
    val progress: Float get() = if (count == 0) 1f else (count - remaining).toFloat() / count

    /**
     * The screen for a flow already [showing] or about to show: one on
     * screen whose last step was just done or skipped (the server says
     * finished) still ends on the finish, which completes onboarding; on a
     * server without gates there is no flow.
     */
    fun step(showing: Boolean): Step? = step ?: Step.Finish.takeIf { showing && !legacy }

    companion object {
        fun of(onboarding: CloudOnboarding): OnboardingPlan {
            // Shown: known here, and the person can see to it or is held by it.
            val shown = onboarding.gates.filter { it.kind != OnboardingGate.Kind.Unknown && (it.canComplete || it.blocking) }
            val actionable = shown.filter { it.pending && it.actionable }
            val step: Step? = when {
                onboarding.legacy || onboarding.finished -> null
                actionable.isNotEmpty() -> Step.Gate(actionable.first())
                else -> {
                    val held = onboarding.gates.filter { it.blocking }
                    when {
                        held.any { it.kind == OnboardingGate.Kind.Unknown && it.canComplete && it.status != OnboardingGate.Status.Unavailable } -> Step.Update
                        held.isEmpty() -> Step.Finish
                        else -> Step.Waiting(held)
                    }
                }
            }
            return OnboardingPlan(step, onboarding.legacy, shown.size, actionable.size)
        }
    }
}
