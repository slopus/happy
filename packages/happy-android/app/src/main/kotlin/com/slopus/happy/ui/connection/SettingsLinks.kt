package com.slopus.happy.ui.connection

import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.connection.HappyCloud
import com.slopus.happy.ui.SettingsRoute

/**
 * Where a settings link (`happy://settings/<page>`, API.md "Settings
 * links") goes on this phone, as iOS maps it: the app's own page where it
 * has one, a Happy Cloud server's web settings for the rest, and nothing
 * on any other connection. Opening one only navigates.
 */
sealed interface SettingsPlace {
    /** The connection's Settings, which lists every account on the phone too. */
    data object General : SettingsPlace
    data object Profile : SettingsPlace
    data object Sharing : SettingsPlace
    data object Voice : SettingsPlace
    /** Happy Cloud's servers. */
    data object Servers : SettingsPlace
    data object Members : SettingsPlace
    /** Instructions are documents in the server's Policy vault. */
    data object Instructions : SettingsPlace
    data object ComputePools : SettingsPlace
    /**
     * Happy Cloud's AI providers: the list, with [add]'s flow over it when a
     * link asks for one ([CloudProviderFlow]), kept in [destination] when it says.
     */
    data class Providers(val add: CloudProviderFlow? = null, val destination: com.slopus.happy.agent.CloudDestination? = null) : SettingsPlace
    /** The page in the web app, in a Custom Tab. */
    data class Web(val url: String) : SettingsPlace
}

object SettingsLinks {
    /** [page] on a connection to [server]; [cloud] when that is a Happy Cloud server this build signs in to. Null where it's inert. */
    fun place(page: String, server: String?, cloud: Boolean, query: Map<String, String> = emptyMap()): SettingsPlace? = when (page) {
        "general" -> SettingsPlace.General
        "account" -> SettingsPlace.Profile
        "sharing" -> SettingsPlace.Sharing
        "voice" -> SettingsPlace.Voice
        "servers" -> if (cloud) SettingsPlace.Servers else SettingsPlace.General
        "members" -> if (cloud) SettingsPlace.Members else null
        "instructions" -> if (cloud) SettingsPlace.Instructions else null
        "mobile-access", "experimental", "dev", "server" -> null
        "computes" -> if (cloud) SettingsPlace.ComputePools else null
        // The shared targets (w8548): the list, the chooser, each flow. Import is the desktop's; here it is the chooser.
        "providers", "providers/add", "providers/import", "providers/add/openai", "providers/add/anthropic", "providers/add/api-key" ->
            if (!cloud) null else SettingsPlace.Providers(
                add = when (page) {
                    "providers" -> null
                    "providers/add/openai" -> CloudProviderFlow.ChatGpt
                    "providers/add/anthropic" -> CloudProviderFlow.Claude
                    "providers/add/api-key" -> CloudProviderFlow.ApiKey(query["vendor"])
                    else -> CloudProviderFlow.Choose
                },
                destination = com.slopus.happy.agent.CloudDestination.of(query["to"]),
            )
        else -> if (cloud) HappyCloud.webSettings(server, page)?.let(SettingsPlace::Web) else null
    }

    /** [page] on agent connection [connectionId]. */
    fun place(graph: AppGraph, connectionId: String, page: String, query: Map<String, String> = emptyMap()): SettingsPlace? {
        val server = graph.agentConnections.accounts.value.firstOrNull { it.id == connectionId }?.server
        return place(page, server, cloud = graph.cloudAccount != null && HappyCloud.isServer(server), query)
    }
}

/** Opens [page] of [connectionId]'s settings, a web page through [openWeb], or nothing where the phone has no such page. */
fun NavHostController.openSettingsLink(graph: AppGraph, connectionId: String, page: String, openWeb: (String) -> Unit, query: Map<String, String> = emptyMap()) {
    when (val place = SettingsLinks.place(graph, connectionId, page, query)) {
        SettingsPlace.General -> navigate(SettingsRoute())
        SettingsPlace.Profile -> navigate(AgentProfileRoute(connectionId))
        SettingsPlace.Sharing -> navigate(AgentSharingRoute(connectionId))
        SettingsPlace.Voice -> navigate(AgentVoiceRoute(connectionId))
        SettingsPlace.Members -> navigate(CloudMembersRoute(connectionId))
        SettingsPlace.Instructions -> navigate(CloudInstructionsRoute(connectionId))
        SettingsPlace.ComputePools -> navigate(CloudComputePoolsRoute(connectionId))
        is SettingsPlace.Providers -> openCloudProviders(connectionId, place.add, place.destination)
        SettingsPlace.Servers -> {
            // As the account menu's Connect: a pass whose hour is up opens on the sign-in.
            graph.cloudAccount?.signedIn()
            navigate(CloudRoute) { launchSingleTop = true }
        }
        is SettingsPlace.Web -> openWeb(place.url)
        null -> Unit
    }
}
