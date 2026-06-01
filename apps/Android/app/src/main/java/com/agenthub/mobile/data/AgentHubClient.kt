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

    suspend fun sync(config: ConnectionConfig): MobileSyncResponse {
        return runCatching {
            get<MobileSyncResponse>(config, "/mobile/sync")
        }.getOrElse { error ->
            if (error.isHttpNotFound()) legacySync(config) else throw error
        }
    }

    suspend fun workbench(config: ConnectionConfig): MobileWorkbenchResponse {
        return runCatching {
            get<MobileWorkbenchResponse>(config, "/mobile/workbench")
        }.getOrElse { error ->
            if (error.isHttpNotFound()) MobileWorkbenchResponse() else throw error
        }
    }

    suspend fun listMessages(config: ConnectionConfig, sessionId: String): List<Message> {
        return get<ListResponse<Message>>(config, "/messages/$sessionId").items
    }

    suspend fun createSession(config: ConnectionConfig, title: String): Session {
        return post(config, "/sessions", CreateSessionRequest(title = title))
    }

    suspend fun openWorkspaceGroupSession(config: ConnectionConfig, workspaceId: String): Session {
        return post<SessionResponse>(config, "/workspaces/$workspaceId/group-session").session
    }

    suspend fun deleteSession(config: ConnectionConfig, sessionId: String) {
        request<Unit>(config, "/sessions/$sessionId") { it.delete() }
    }

    suspend fun openWorkspaceAgentSession(
        config: ConnectionConfig,
        workspaceId: String,
        agentId: String,
    ): Session {
        return runCatching {
            post<SessionResponse>(config, "/workspaces/$workspaceId/agents/$agentId/session").session
        }.getOrElse { error ->
            if (error.isHttpNotFound()) {
                val sync = legacySync(config)
                val workspace = sync.workspaces.firstOrNull { it.id == workspaceId }
                val agent = sync.agents.firstOrNull { it.id == agentId && it.workspaceId == workspaceId }
                val title = listOfNotNull(
                    workspace?.name?.takeIf { it.isNotBlank() },
                    agent?.name?.takeIf { it.isNotBlank() },
                ).joinToString(" / ").ifBlank { "Agent 对话" }
                post(
                    config = config,
                    path = "/sessions",
                    body = CreateSessionRequest(
                        title = title,
                        type = "direct",
                        workspaceId = workspaceId,
                        workspaceAgentId = agentId,
                    ),
                )
            } else {
                throw error
            }
        }
    }

    suspend fun openAgentContactSession(config: ConnectionConfig, contact: AgentContact): Session {
        val workspaceId = contact.workspaceId
        val workspaceAgentId = contact.workspaceAgentId
        if (!workspaceId.isNullOrBlank() && !workspaceAgentId.isNullOrBlank()) {
            return openWorkspaceAgentSession(config, workspaceId, workspaceAgentId)
        }
        return post<SessionResponse>(config, "/mobile/agents/${contact.id}/session").session
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

    private suspend fun legacySync(config: ConnectionConfig): MobileSyncResponse {
        val sessions = listSessions(config)
        val workspaces = get<ListResponse<Workspace>>(config, "/workspaces").items
        val agents = workspaces.flatMap { workspace ->
            runCatching { get<WorkspaceFullResponse>(config, "/workspaces/${workspace.id}").agents }
                .getOrDefault(emptyList())
        }
        return MobileSyncResponse(
            sessions = sessions,
            workspaces = workspaces,
            agents = agents,
            contacts = dedupeWorkspaceAgents(agents),
        )
    }

    suspend fun startOffice(config: ConnectionConfig): MobileWorkbenchOfficeStatus {
        return post(config, "/office/start", timeoutMillis = 30_000L)
    }

    suspend fun openFirewallPort(config: ConnectionConfig): WorkbenchActionResponse {
        return post(config, "/mobile/firewall/open", timeoutMillis = 60_000L)
    }

    suspend fun installCodingTools(config: ConnectionConfig): WorkbenchActionResponse {
        return post(config, "/coding-tools/cli/install", timeoutMillis = 10L * 60 * 1000)
    }

    suspend fun repairCodingTools(config: ConnectionConfig): WorkbenchActionResponse {
        return post(config, "/coding-tools/lifecycle/startup", timeoutMillis = 60_000L)
    }

    suspend fun getSettings(config: ConnectionConfig): Map<String, String> {
        return get<Map<String, String>>(config, "/settings")
    }

    suspend fun updateSettings(config: ConnectionConfig, settings: Map<String, String>) {
        post<Map<String, String>, Unit>(config, "/settings", settings)
    }

    suspend fun testModel(config: ConnectionConfig, request: TestModelRequest): TestModelResponse {
        return post(config, "/settings/test-model", request, timeoutMillis = 30_000L)
    }

    private fun dedupeWorkspaceAgents(agents: List<WorkspaceAgent>): List<AgentContact> {
        val seen = mutableSetOf<String>()
        return agents.mapNotNull { agent ->
            val runtimeType = agent.runtimeType.trim().lowercase()
            val codeAgentType = if (runtimeType == "code-agent") {
                agent.codeAgentType?.trim()?.lowercase().orEmpty()
            } else {
                ""
            }
            val key = listOf(
                agent.name.trim().lowercase(),
                agent.role.trim().lowercase(),
                runtimeType,
                codeAgentType,
            ).joinToString("|")
            if (!seen.add(key)) return@mapNotNull null
            AgentContact(
                id = agent.id,
                source = "workspace-agent",
                workspaceId = agent.workspaceId,
                workspaceAgentId = agent.id,
                name = agent.name,
                role = agent.role,
                roleType = agent.roleType,
                description = agent.description,
                avatar = agent.avatar,
                color = agent.color,
                runtimeType = agent.runtimeType,
                codeAgentType = agent.codeAgentType,
                capabilityTags = agent.capabilityTags,
            )
        }
    }

    private suspend inline fun <reified T> get(config: ConnectionConfig, path: String): T {
        return request(config, path) { it.get() }
    }

    private suspend inline fun <reified B, reified T> post(
        config: ConnectionConfig,
        path: String,
        body: B,
        timeoutMillis: Long? = null,
    ): T {
        val requestBody = json.encodeToString(body).toRequestBody(JSON_MEDIA_TYPE)
        return request(config, path, timeoutMillis) { it.post(requestBody) }
    }

    private suspend inline fun <reified T> post(
        config: ConnectionConfig,
        path: String,
        timeoutMillis: Long? = null,
    ): T {
        val requestBody = "{}".toRequestBody(JSON_MEDIA_TYPE)
        return request(config, path, timeoutMillis) { it.post(requestBody) }
    }

    private suspend inline fun <reified T> request(
        config: ConnectionConfig,
        path: String,
        timeoutMillis: Long? = null,
        crossinline build: (Request.Builder) -> Request.Builder,
    ): T = withContext(Dispatchers.IO) {
        val request = build(requestBuilder(config, path)).build()
        val client = timeoutMillis?.let {
            httpClient.newBuilder()
                .readTimeout(it, TimeUnit.MILLISECONDS)
                .build()
        } ?: httpClient
        client.newCall(request).execute().use { response ->
            val responseBody = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw IOException("HTTP ${response.code}: ${responseBody.ifBlank { response.message }}")
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

    private fun Throwable.isHttpNotFound(): Boolean {
        return this is IOException && message.orEmpty().contains("HTTP 404")
    }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
