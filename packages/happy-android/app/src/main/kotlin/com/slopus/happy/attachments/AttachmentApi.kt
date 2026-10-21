package com.slopus.happy.attachments

import com.slopus.happy.net.HappyJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Attachments are limited to 10 MB, encrypted (attachmentRoutes.ts MAX_FILE_SIZE). */
const val MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** request-upload's answer: where to send the encrypted blob, and how. */
data class AttachmentUpload(
    val ref: String,
    val uploadUrl: String,
    val method: AttachmentDiagnosticMethod,
    /** The S3 presigned POST policy's form fields (method POST). */
    val formFields: Map<String, String> = emptyMap(),
)

@Serializable
private data class RequestUploadResponse(
    val ref: String,
    val uploadUrl: String,
    val method: String,
    val formFields: Map<String, String>? = null,
)

@Serializable
private data class RequestDownloadResponse(val downloadUrl: String)

/**
 * apiAttachments.ts: image attachment transfer. The server either hosts the
 * blobs itself (PUT/GET back to it, with the bearer token) or hands out S3
 * presigned URLs (POST policy up, GET down, no Happy headers). Every failure
 * is an [AttachmentDiagnosticError] whose message and diagnostic are safe to
 * log.
 */
class AttachmentApi(
    private val client: OkHttpClient,
    private val serverUrl: () -> String,
) {
    /** requestAttachmentUpload: POST /v1/sessions/:id/attachments/request-upload. */
    suspend fun requestUpload(token: String, sessionId: String, filename: String, size: Long): AttachmentUpload {
        val server = serverUrl()
        val url = "$server/v1/sessions/$sessionId/attachments/request-upload"
        fun input(status: Int? = null, statusText: String? = null, message: String? = null) = AttachmentDiagnosticInput(
            AttachmentDiagnosticLeg.RequestUpload, AttachmentDiagnosticMethod.POST, url, server, status, statusText, message,
        )
        val body = HappyJson.encodeToString(
            JsonObject.serializer(),
            JsonObject(mapOf("filename" to JsonPrimitive(filename), "size" to JsonPrimitive(size))),
        )
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .post(body.toByteArray().toRequestBody(JSON))
            .build()
        val text = exchange(request, { input(message = it) }, "request-upload network error") { response, text ->
            when (response.code) {
                413 -> "Attachment too large (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB)"
                404 -> "Session not found"
                else -> "request-upload failed: ${response.code}"
            }.let { throw createAttachmentDiagnosticError(it, input(response.code, response.message)) }
        }
        val result = parse(text, RequestUploadResponse.serializer()) { message ->
            createAttachmentDiagnosticError(format("request-upload response parse error", message), input(message = message))
        }
        return AttachmentUpload(
            ref = result.ref,
            uploadUrl = rewriteLoopbackHost(result.uploadUrl, server),
            method = if (result.method == "POST") AttachmentDiagnosticMethod.POST else AttachmentDiagnosticMethod.PUT,
            formFields = result.formFields.orEmpty(),
        )
    }

    /**
     * uploadEncryptedBlob. PUT (our own server): the raw bytes as
     * octet-stream, with the bearer token only when the URL is the server's.
     * POST (S3 policy): multipart with the policy's fields, then the file.
     */
    suspend fun uploadBlob(upload: AttachmentUpload, encrypted: ByteArray, token: String) {
        val server = serverUrl()
        val method = upload.method
        fun input(status: Int? = null, statusText: String? = null, message: String? = null) = AttachmentDiagnosticInput(
            AttachmentDiagnosticLeg.BlobUpload, method, upload.uploadUrl, server, status, statusText, message,
        )
        val request = try {
            if (method == AttachmentDiagnosticMethod.POST) {
                val form = MultipartBody.Builder().setType(MultipartBody.FORM)
                upload.formFields.forEach { (key, value) -> form.addFormDataPart(key, value) }
                form.addFormDataPart("file", "blob", encrypted.toRequestBody(OCTET_STREAM))
                Request.Builder().url(upload.uploadUrl).post(form.build()).build()
            } else {
                Request.Builder()
                    .url(upload.uploadUrl)
                    .apply { if (upload.uploadUrl.startsWith(server)) header("Authorization", "Bearer $token") }
                    .put(encrypted.toRequestBody(OCTET_STREAM))
                    .build()
            }
        } catch (e: IllegalArgumentException) {
            // fetch rejects a URL it can't parse before sending: a network error.
            val message = errorMessageFromUnknown(e)
            throw createAttachmentDiagnosticError(format("Blob upload (${method.name}) network error", message), input(message = message))
        }
        exchange(request, { input(message = it) }, "Blob upload (${method.name}) network error") { response, _ ->
            throw createAttachmentDiagnosticError(
                "Blob upload (${method.name}) failed: ${response.code} ${response.message}",
                input(response.code, response.message),
            )
        }
    }

    /**
     * downloadEncryptedAttachment: POST request-download for a URL, then GET
     * it (with the bearer token only when it is the server's; presigned S3
     * URLs reject extra headers).
     */
    suspend fun download(token: String, sessionId: String, ref: String): ByteArray {
        val server = serverUrl()
        val requestUrl = "$server/v1/sessions/$sessionId/attachments/request-download"
        fun requestInput(status: Int? = null, statusText: String? = null, message: String? = null) = AttachmentDiagnosticInput(
            AttachmentDiagnosticLeg.RequestDownload, AttachmentDiagnosticMethod.POST, requestUrl, server, status, statusText, message,
        )
        val body = HappyJson.encodeToString(JsonObject.serializer(), JsonObject(mapOf("ref" to JsonPrimitive(ref))))
        val request = Request.Builder()
            .url(requestUrl)
            .header("Authorization", "Bearer $token")
            .post(body.toByteArray().toRequestBody(JSON))
            .build()
        val text = exchange(request, { requestInput(message = it) }, "request-download network error") { response, _ ->
            throw createAttachmentDiagnosticError("request-download failed: ${response.code}", requestInput(response.code, response.message))
        }
        val raw = parse(text, RequestDownloadResponse.serializer()) { message ->
            createAttachmentDiagnosticError(format("request-download response parse error", message), requestInput(message = message))
        }.downloadUrl
        val downloadUrl = rewriteLoopbackHost(raw, server)

        fun blobInput(status: Int? = null, statusText: String? = null, message: String? = null) = AttachmentDiagnosticInput(
            AttachmentDiagnosticLeg.BlobDownload, AttachmentDiagnosticMethod.GET, downloadUrl, server, status, statusText, message,
        )
        val get = try {
            Request.Builder()
                .url(downloadUrl)
                .apply { if (downloadUrl.startsWith(server)) header("Authorization", "Bearer $token") }
                .get()
                .build()
        } catch (e: IllegalArgumentException) {
            val message = errorMessageFromUnknown(e)
            throw createAttachmentDiagnosticError(format("Attachment download network error", message), blobInput(message = message))
        }
        val response = try {
            client.newCall(get).await()
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            val message = errorMessageFromUnknown(e)
            throw createAttachmentDiagnosticError(format("Attachment download network error", message), blobInput(message = message))
        }
        return response.use {
            if (!it.isSuccessful) {
                throw createAttachmentDiagnosticError(
                    "Attachment download failed: ${it.code} ${it.message}",
                    blobInput(it.code, it.message),
                )
            }
            try {
                it.body.bytes()
            } catch (e: IOException) {
                val message = errorMessageFromUnknown(e)
                throw createAttachmentDiagnosticError(format("Attachment download body read error", message), blobInput(message = message))
            }
        }
    }

    /** Sends [request]; a non-2xx goes to [onError], which throws. Returns the body text. */
    private suspend fun exchange(
        request: Request,
        networkInput: (String) -> AttachmentDiagnosticInput,
        networkPrefix: String,
        onError: (Response, String) -> Nothing,
    ): String {
        val response = try {
            client.newCall(request).await()
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            val message = errorMessageFromUnknown(e)
            throw createAttachmentDiagnosticError(format(networkPrefix, message), networkInput(message))
        }
        return response.use {
            val text = try {
                it.body.string()
            } catch (e: IOException) {
                val message = errorMessageFromUnknown(e)
                throw createAttachmentDiagnosticError(format(networkPrefix, message), networkInput(message))
            }
            if (!it.isSuccessful) onError(it, text)
            text
        }
    }

    private fun <T> parse(text: String, serializer: kotlinx.serialization.KSerializer<T>, error: (String) -> AttachmentDiagnosticError): T =
        try {
            HappyJson.decodeFromString(serializer, text)
        } catch (e: SerializationException) {
            throw error(errorMessageFromUnknown(e))
        } catch (e: IllegalArgumentException) {
            throw error(errorMessageFromUnknown(e))
        }

    private companion object {
        val JSON = "application/json".toMediaType()
        val OCTET_STREAM = "application/octet-stream".toMediaType()

        fun format(prefix: String, message: String) = if (message.isNotEmpty()) "$prefix: $message" else prefix
    }
}

/**
 * serverConfig.ts rewriteLoopbackHost: a server that names itself
 * localhost in the URLs it hands out (a dev server reached over the LAN)
 * gets the scheme and host the app reaches it by.
 */
fun rewriteLoopbackHost(url: String, serverUrl: String): String {
    val target = url.toHttpUrlOrNull() ?: return url
    if (target.host != "localhost" && target.host != "127.0.0.1" && target.host != "::1") return url
    val reachable = serverUrl.toHttpUrlOrNull() ?: return url
    return target.newBuilder().scheme(reachable.scheme).host(reachable.host).port(reachable.port).build().toString()
}

private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) = continuation.resume(response) { _, _, _ -> response.close() }
        override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(e)
    })
}
