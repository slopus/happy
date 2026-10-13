package com.slopus.happy.auth

import com.slopus.happy.crypto.AuthChallenge
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.net.HttpStatusException
import kotlinx.serialization.Serializable
import java.io.IOException

/** The unauthenticated and account-link endpoints of happy-server's authRoutes.ts. */
class AuthApi(private val http: HappyHttp) {

    @Serializable
    private data class TokenRequest(val publicKey: String, val challenge: String, val signature: String)

    @Serializable
    private data class TokenResponse(val token: String)

    @Serializable
    private data class PublicKeyRequest(val publicKey: String)

    @Serializable
    data class AccountLinkState(val state: String, val token: String? = null, val response: String? = null)

    @Serializable
    private data class ApproveRequest(val publicKey: String, val response: String)

    @Serializable
    private data class SuccessResponse(val success: Boolean = true)

    /** POST /v1/auth (authGetToken.ts): exchange a signed challenge for a token. Creates the account on first use. */
    suspend fun getToken(challenge: AuthChallenge): String = http.post(
        path = "/v1/auth",
        body = TokenRequest(
            publicKey = encodeBase64(challenge.publicKey),
            challenge = encodeBase64(challenge.challenge),
            signature = encodeBase64(challenge.signature),
        ),
        bodySerializer = TokenRequest.serializer(),
        response = TokenResponse.serializer(),
    ).token

    /** POST /v1/auth/account/request (authQRStart.ts / authQRWait.ts). Idempotent; poll it until `authorized`. */
    suspend fun requestAccountLink(publicKey: ByteArray): AccountLinkState = http.post(
        path = "/v1/auth/account/request",
        body = PublicKeyRequest(encodeBase64(publicKey)),
        bodySerializer = PublicKeyRequest.serializer(),
        response = AccountLinkState.serializer(),
    )

    /** POST /v1/auth/account/response (authAccountApprove.ts): an existing device hands its secret to a new one. */
    suspend fun approveAccountLink(token: String, publicKey: ByteArray, response: ByteArray) {
        http.post(
            path = "/v1/auth/account/response",
            body = ApproveRequest(publicKey = encodeBase64(publicKey), response = encodeBase64(response)),
            bodySerializer = ApproveRequest.serializer(),
            response = SuccessResponse.serializer(),
            token = token,
        )
    }

    enum class ServerProbe { HappyServer, NotHappyServer, ServerError, Unreachable }

    /** server.tsx validateServer: GET / must answer 2xx with the server banner. */
    suspend fun probeServer(url: String): ServerProbe = try {
        val text = http.getText(url.trim().trimEnd('/') + "/")
        if (text.contains("Welcome to Happy Server!")) ServerProbe.HappyServer else ServerProbe.NotHappyServer
    } catch (_: HttpStatusException) {
        ServerProbe.ServerError
    } catch (_: IOException) {
        ServerProbe.Unreachable
    } catch (_: IllegalArgumentException) {
        ServerProbe.Unreachable
    }
}
