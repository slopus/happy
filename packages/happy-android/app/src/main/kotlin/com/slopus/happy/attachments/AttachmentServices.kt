package com.slopus.happy.attachments

import com.slopus.happy.AppGraph
import com.slopus.happy.auth.AuthState
import okhttp3.OkHttpClient
import java.util.WeakHashMap
import java.util.concurrent.TimeUnit

/**
 * The graph's attachment transfers, built on first use. They follow the
 * signed-in account: the token and the account's blob keys are read per
 * call, and the decrypted-blob cache is dropped when the account changes.
 */
class AttachmentServices private constructor(private val graph: AppGraph) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()
    val api = AttachmentApi(client, serverUrl = { graph.serverConfig.url.value })

    private var account: Pair<AuthState.SignedIn, AttachmentTransfers>? = null

    /** The signed-in account's transfers, or null when signed out. */
    val transfers: AttachmentTransfers?
        @Synchronized get() {
            val signedIn = graph.auth.state.value as? AuthState.SignedIn ?: return null.also { account = null }
            account?.let { (state, transfers) -> if (state == signedIn) return transfers }
            val blobKeys = SessionBlobKeys(graph.store, signedIn.encryption)
            val transfers = AttachmentTransfers(api, blobKeys::blobKey, token = { signedIn.credentials.token })
            account = signedIn to transfers
            return transfers
        }

    companion object {
        private val instances = WeakHashMap<AppGraph, AttachmentServices>()

        fun of(graph: AppGraph): AttachmentServices = synchronized(instances) {
            instances.getOrPut(graph) { AttachmentServices(graph) }
        }
    }
}
