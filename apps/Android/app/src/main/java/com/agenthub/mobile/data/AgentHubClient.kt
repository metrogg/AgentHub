package com.agenthub.mobile.data

import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

class AgentHubClient(
    private val json: Json,
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build(),
) {
    suspend fun health(config: ConnectionConfig): Boolean = withContext(Dispatchers.IO) {
        val request = requestBuilder(config, "/health", withApiPrefix = false).get().build()
        httpClient.newCall(request).execute().use { it.isSuccessful }
    }

    suspend fun listSessions(config: ConnectionConfig): List<Session> {
        return get<ListResponse<Session>>(config, "/sessions").items
    }

    suspend fun listMessages(config: ConnectionConfig, sessionId: String): List<Message> {
        return get<ListResponse<Message>>(config, "/messages/$sessionId").items
    }

    suspend fun createSession(config: ConnectionConfig, title: String): Session {
        return post(config, "/sessions", CreateSessionRequest(title = title))
    }

    suspend fun deleteSession(config: ConnectionConfig, sessionId: String) {
        request<Unit>(config, "/sessions/$sessionId") { it.delete() }
    }

    suspend fun sendMessage(
        config: ConnectionConfig,
        sessionId: String,
        content: String,
        clientMessageId: String,
    ): Message {
        return post(
            config = config,
            path = "/messages/$sessionId",
            body = SendMessageRequest(content = content, clientMessageId = clientMessageId),
        )
    }

    suspend fun confirmPairing(
        payload: PairingPayload,
        deviceName: String = "Android",
        baseUrl: String = payload.baseUrl,
    ): PairConfirmResponse {
        return post(
            config = ConnectionConfig(baseUrl = baseUrl),
            path = "/mobile/pair/confirm",
            body = PairConfirmRequest(pairingCode = payload.pairingCode, deviceName = deviceName),
        )
    }

    fun openEventSocket(
        config: ConnectionConfig,
        listener: WebSocketListener,
    ): WebSocket {
        val request = Request.Builder()
            .url(webSocketUrl(config))
            .applyAuth(config)
            .build()
        return httpClient.newWebSocket(request, listener)
    }

    fun joinSession(webSocket: WebSocket, sessionId: String) {
        webSocket.send(json.encodeToString(JoinSessionCommand(payload = JoinSessionPayload(sessionId))))
    }

    private suspend inline fun <reified T> get(config: ConnectionConfig, path: String): T {
        return request(config, path) { it.get() }
    }

    private suspend inline fun <reified B, reified T> post(config: ConnectionConfig, path: String, body: B): T {
        val requestBody = json.encodeToString(body).toRequestBody(JSON_MEDIA_TYPE)
        return request(config, path) { it.post(requestBody) }
    }

    private suspend inline fun <reified T> request(
        config: ConnectionConfig,
        path: String,
        crossinline build: (Request.Builder) -> Request.Builder,
    ): T = withContext(Dispatchers.IO) {
        val request = build(requestBuilder(config, path)).build()
        httpClient.newCall(request).execute().use { response ->
            val responseBody = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw IOException(responseBody.ifBlank { "HTTP ${response.code}" })
            }
            if (response.code == 204 || responseBody.isBlank()) return@withContext Unit as T
            json.decodeFromString(responseBody)
        }
    }

    private fun requestBuilder(
        config: ConnectionConfig,
        path: String,
        withApiPrefix: Boolean = true,
    ): Request.Builder {
        val cleanBase = config.baseUrl.trim().trimEnd('/')
        val cleanPath = path.trimStart('/')
        val url = if (withApiPrefix) "$cleanBase/api/$cleanPath" else "$cleanBase/$cleanPath"
        return Request.Builder()
            .url(url)
            .applyAuth(config)
            .header("Content-Type", "application/json")
    }

    private fun webSocketUrl(config: ConnectionConfig): String {
        val cleanBase = config.baseUrl.trim().trimEnd('/')
        return when {
            cleanBase.startsWith("https://") -> cleanBase.replaceFirst("https://", "wss://") + "/ws"
            cleanBase.startsWith("http://") -> cleanBase.replaceFirst("http://", "ws://") + "/ws"
            else -> "ws://$cleanBase/ws"
        }
    }

    private fun Request.Builder.applyAuth(config: ConnectionConfig): Request.Builder {
        val token = config.authToken?.trim()
        if (!token.isNullOrBlank()) header("Authorization", "Bearer $token")
        return this
    }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
