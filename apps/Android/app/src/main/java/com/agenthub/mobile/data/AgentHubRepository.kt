package com.agenthub.mobile.data

import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

class AgentHubRepository(
    private val scope: CoroutineScope,
    private val client: AgentHubClient,
    private val json: Json,
) {
    private val _uiState = MutableStateFlow(MobileUiState())
    val uiState: StateFlow<MobileUiState> = _uiState.asStateFlow()

    private var currentSocket: WebSocket? = null
    private var syncJob: Job? = null
    private var messageRefreshJob: Job? = null

    fun connect(config: ConnectionConfig) {
        scope.launch {
            _uiState.update {
                it.copy(connection = config, connecting = true, error = null, workbenchLoading = true)
            }
            runCatching {
                client.health(config)
                val sync = client.sync(config)
                val workbench = runCatching { client.workbench(config) }.getOrNull()
                currentSocket?.cancel()
                currentSocket = client.openEventSocket(config, socketListener(config))
                applySync(sync)
                _uiState.update {
                    it.copy(workbench = workbench, workbenchLoading = false)
                }
                _uiState.update {
                    it.copy(
                        connecting = false,
                        connected = true,
                    )
                }
                startSyncLoop(config)
                _uiState.value.selectedSessionId?.let { selectSession(it) }
            }.onFailure { error ->
                _uiState.update {
                    it.copy(connecting = false, connected = false, workbenchLoading = false, error = error.message ?: "连接失败")
                }
            }
        }
    }

    fun disconnect() {
        syncJob?.cancel()
        syncJob = null
        messageRefreshJob?.cancel()
        messageRefreshJob = null
        currentSocket?.cancel()
        currentSocket = null
        _uiState.update {
            MobileUiState()
        }
    }

    fun refreshSessions() {
        val config = _uiState.value.connection ?: run {
            setError("请先点击右上角 +，选择扫一扫连接电脑端")
            return
        }
        scope.launch {
            runCatching { client.sync(config) }
                .onSuccess { sync -> applySync(sync) }
                .onFailure { error -> _uiState.update { it.copy(error = error.message) } }
        }
    }

    fun refreshWorkbench() {
        val config = _uiState.value.connection ?: run {
            setError("请先点击右上角 +，选择扫一扫连接电脑端")
            return
        }
        scope.launch {
            _uiState.update { it.copy(workbenchLoading = true) }
            runCatching { client.workbench(config) }
                .onSuccess { workbench ->
                    _uiState.update {
                        it.copy(workbench = workbench, workbenchLoading = false, error = null)
                    }
                }
                .onFailure { error ->
                    _uiState.update {
                        it.copy(workbenchLoading = false, error = error.message)
                    }
                }
        }
    }

    suspend fun confirmPairing(payload: PairingPayload): PairConfirmResponse {
        _uiState.update { it.copy(connecting = true, error = null) }
        val candidates = pairingBaseUrlCandidates(payload)
        if (candidates.isEmpty()) {
            val message = "二维码里没有可供真机访问的电脑端地址，请在电脑端重新生成二维码。"
            _uiState.update { it.copy(connecting = false, error = message) }
            throw IllegalStateException(message)
        }
        var lastError: Throwable? = null
        for (baseUrl in candidates) {
            val result = runCatching { client.confirmPairing(payload, baseUrl = baseUrl) }
            if (result.isSuccess) {
                _uiState.update { state -> state.copy(connecting = false, error = null) }
                val confirmed = result.getOrThrow()
                return confirmed.copy(baseUrl = baseUrl)
            }
            lastError = result.exceptionOrNull()
        }
        val message = buildString {
            append("无法连接电脑端，已尝试 ")
            append(candidates.joinToString("、"))
            lastError?.message?.takeIf { it.isNotBlank() }?.let { append("：").append(it) }
        }
        _uiState.update { it.copy(connecting = false, error = message) }
        throw lastError ?: IllegalStateException(message)
    }

    fun setError(message: String) {
        _uiState.update { it.copy(connecting = false, error = message) }
    }

    fun setArchivedSessionIds(ids: Set<String>) {
        _uiState.update { it.copy(archivedSessionIds = ids) }
    }

    fun createSession(title: String = "新会话") {
        val config = _uiState.value.connection ?: run {
            setError("请先点击右上角 +，选择扫一扫连接电脑端")
            return
        }
        scope.launch {
            runCatching { client.createSession(config, title) }
                .onSuccess { session ->
                    _uiState.update { it.copy(sessions = listOf(session) + it.sessions) }
                    refreshSessions()
                    selectSession(session.id)
                }
                .onFailure { error -> _uiState.update { it.copy(error = error.message) } }
        }
    }

    fun openWorkspaceAgent(workspaceId: String, agentId: String) {
        val config = _uiState.value.connection ?: run {
            setError("请先点击右上角 +，选择扫一扫连接电脑端")
            return
        }
        scope.launch {
            runCatching { client.openWorkspaceAgentSession(config, workspaceId, agentId) }
                .onSuccess { session ->
                    _uiState.update {
                        it.copy(
                            sessions = listOf(session) + it.sessions.filterNot { item -> item.id == session.id },
                            error = null,
                        )
                    }
                    refreshSessions()
                    selectSession(session.id)
                }
                .onFailure { error -> _uiState.update { it.copy(error = error.message) } }
        }
    }

    fun openWorkspaceGroupSession(workspaceId: String, agentIds: List<String> = emptyList(), title: String? = null) {
        val config = _uiState.value.connection ?: run {
            setError("请先点击右上角 +，选择扫一扫连接电脑端")
            return
        }
        scope.launch {
            runCatching { client.openWorkspaceGroupSession(config, workspaceId, agentIds, title) }
                .onSuccess { session ->
                    _uiState.update {
                        it.copy(
                            sessions = listOf(session) + it.sessions.filterNot { item -> item.id == session.id },
                            error = null,
                        )
                    }
                    refreshSessions()
                    refreshWorkbench()
                    selectSession(session.id)
                }
                .onFailure { error -> _uiState.update { it.copy(error = error.message) } }
        }
    }

    fun openContactGroupSession(agentIds: List<String> = emptyList(), title: String? = null) {
        val config = _uiState.value.connection ?: run {
            setError("请先点击右上角 +，选择扫一扫连接电脑端")
            return
        }
        if (agentIds.isEmpty()) {
            setError("请选择至少一个 Agent")
            return
        }
        scope.launch {
            runCatching { client.openContactGroupSession(config, agentIds, title) }
                .onSuccess { session ->
                    _uiState.update {
                        it.copy(
                            sessions = listOf(session) + it.sessions.filterNot { item -> item.id == session.id },
                            error = null,
                        )
                    }
                    refreshSessions()
                    refreshWorkbench()
                    selectSession(session.id)
                }
                .onFailure { error -> _uiState.update { it.copy(error = error.message) } }
        }
    }

    fun openAgentContact(contact: AgentContact) {
        val config = _uiState.value.connection ?: run {
            setError("请先点击右上角 +，选择扫一扫连接电脑端")
            return
        }
        scope.launch {
            runCatching { client.openAgentContactSession(config, contact) }
                .onSuccess { session ->
                    _uiState.update {
                        it.copy(
                            sessions = listOf(session) + it.sessions.filterNot { item -> item.id == session.id },
                            error = null,
                        )
                    }
                    refreshSessions()
                    selectSession(session.id)
                }
                .onFailure { error -> _uiState.update { it.copy(error = error.message) } }
        }
    }

    fun selectSession(sessionId: String) {
        val config = _uiState.value.connection ?: run {
            setError("离线状态下无法打开会话，请先扫码连接电脑端")
            return
        }
        _uiState.update {
            it.copy(
                selectedSessionId = sessionId,
                messages = emptyList(),
                streamingMessage = null,
                streamingCodeAgentRun = null,
                agentTyping = false,
            )
        }
        currentSocket?.let { client.joinSession(it, sessionId) }
        scope.launch {
            runCatching { client.listMessages(config, sessionId) }
                .onSuccess { messages -> _uiState.update { it.copy(messages = messages, error = null) } }
                .onFailure { error -> _uiState.update { it.copy(error = error.message) } }
        }
    }

    fun sendMessage(content: String) {
        val config = _uiState.value.connection ?: run {
            setError("请先点击右上角 +，选择扫一扫连接电脑端")
            return
        }
        val sessionId = _uiState.value.selectedSessionId ?: return
        val trimmed = content.trim()
        if (trimmed.isBlank()) return
        scope.launch {
            runCatching {
                client.sendMessage(
                    config = config,
                    sessionId = sessionId,
                    content = trimmed,
                    clientMessageId = "android-${UUID.randomUUID()}",
                )
            }.onSuccess { message ->
                _uiState.update {
                    it.copy(messages = it.messages + message, agentTyping = true, error = null)
                }
                refreshSessions()
            }.onFailure { error ->
                _uiState.update { it.copy(agentTyping = false, error = error.message) }
            }
        }
    }

    fun archiveSession(sessionId: String) {
        _uiState.update { state ->
            state.copy(
                archivedSessionIds = state.archivedSessionIds + sessionId,
                selectedSessionId = state.selectedSessionId.takeUnless { it == sessionId },
                messages = if (state.selectedSessionId == sessionId) emptyList() else state.messages,
                streamingMessage = if (state.selectedSessionId == sessionId) null else state.streamingMessage,
            )
        }
    }

    fun unarchiveSession(sessionId: String) {
        _uiState.update { it.copy(archivedSessionIds = it.archivedSessionIds - sessionId) }
    }

    fun deleteSession(sessionId: String) {
        val config = _uiState.value.connection ?: run {
            setError("离线状态下无法删除会话，请先扫码连接电脑端")
            return
        }
        scope.launch {
            runCatching { client.deleteSession(config, sessionId) }
                .onSuccess {
                    _uiState.update { state ->
                        state.copy(
                            sessions = state.sessions.filterNot { it.id == sessionId },
                            archivedSessionIds = state.archivedSessionIds - sessionId,
                            selectedSessionId = state.selectedSessionId.takeUnless { it == sessionId },
                            messages = if (state.selectedSessionId == sessionId) emptyList() else state.messages,
                            streamingMessage = if (state.selectedSessionId == sessionId) null else state.streamingMessage,
                            error = null,
                        )
                    }
                }
                .onFailure { error -> _uiState.update { it.copy(error = error.message) } }
        }
    }

    fun startOffice() {
        val config = _uiState.value.connection ?: run {
            setError("请先点击右上角 +，选择扫一扫连接电脑端")
            return
        }
        scope.launch {
            _uiState.update { it.copy(workbenchLoading = true) }
            runCatching { client.startOffice(config) }
                .onSuccess { office ->
                    _uiState.update {
                        it.copy(
                            workbench = it.workbench?.copy(office = office),
                            workbenchLoading = false,
                            error = null,
                        )
                    }
                    refreshWorkbench()
                }
                .onFailure { error -> _uiState.update { it.copy(workbenchLoading = false, error = error.message) } }
        }
    }

    fun openFirewallPort() {
        val config = _uiState.value.connection ?: run {
            setError("请先点击右上角 +，选择扫一扫连接电脑端")
            return
        }
        scope.launch {
            _uiState.update { it.copy(workbenchLoading = true) }
            runCatching { client.openFirewallPort(config) }
                .onSuccess { action ->
                    _uiState.update {
                        it.copy(
                            workbenchLoading = false,
                            error = if (action.ok) null else action.message,
                        )
                    }
                    refreshWorkbench()
                }
                .onFailure { error -> _uiState.update { it.copy(workbenchLoading = false, error = error.message) } }
        }
    }

    fun installCodingTools() {
        val config = _uiState.value.connection ?: run {
            setError("请先点击右上角 +，选择扫一扫连接电脑端")
            return
        }
        scope.launch {
            _uiState.update { it.copy(workbenchLoading = true) }
            runCatching { client.installCodingTools(config) }
                .onSuccess {
                    _uiState.update { it.copy(workbenchLoading = false, error = null) }
                    refreshWorkbench()
                }
                .onFailure { error -> _uiState.update { it.copy(workbenchLoading = false, error = error.message) } }
        }
    }

    fun repairCodingTools() {
        val config = _uiState.value.connection ?: run {
            setError("请先点击右上角 +，选择扫一扫连接电脑端")
            return
        }
        scope.launch {
            _uiState.update { it.copy(workbenchLoading = true) }
            runCatching { client.repairCodingTools(config) }
                .onSuccess {
                    _uiState.update { it.copy(workbenchLoading = false, error = null) }
                    refreshWorkbench()
                }
                .onFailure { error -> _uiState.update { it.copy(workbenchLoading = false, error = error.message) } }
        }
    }

    fun fetchSettings() {
        val config = _uiState.value.connection ?: run {
            setError("请先点击右上角 +，选择扫一扫连接电脑端")
            return
        }
        scope.launch {
            _uiState.update { it.copy(settingsLoading = true) }
            runCatching { client.getSettings(config) }
                .onSuccess { settings ->
                    _uiState.update { it.copy(settings = settings, settingsLoading = false, error = null) }
                }
                .onFailure { error ->
                    _uiState.update { it.copy(settingsLoading = false, error = error.message) }
                }
        }
    }

    fun updateSettings(settings: Map<String, String>) {
        val config = _uiState.value.connection ?: run {
            setError("请先点击右上角 +，选择扫一扫连接电脑端")
            return
        }
        scope.launch {
            _uiState.update { it.copy(settingsLoading = true) }
            runCatching { client.updateSettings(config, settings) }
                .onSuccess {
                    _uiState.update { it.copy(settingsLoading = false, error = null) }
                    fetchSettings()
                    refreshWorkbench()
                }
                .onFailure { error ->
                    _uiState.update { it.copy(settingsLoading = false, error = error.message) }
                }
        }
    }

    fun testModel(request: TestModelRequest) {
        val config = _uiState.value.connection ?: run {
            setError("请先点击右上角 +，选择扫一扫连接电脑端")
            return
        }
        scope.launch {
            _uiState.update { it.copy(settingsLoading = true) }
            runCatching { client.testModel(config, request) }
                .onSuccess { result ->
                    _uiState.update { it.copy(testModelResult = result, settingsLoading = false, error = null) }
                }
                .onFailure { error ->
                    _uiState.update {
                        it.copy(
                            testModelResult = TestModelResponse(ok = false, message = error.message ?: "测试失败"),
                            settingsLoading = false,
                            error = null,
                        )
                    }
                }
        }
    }

    fun clearTestModelResult() {
        _uiState.update { it.copy(testModelResult = null) }
    }

    private fun socketListener(config: ConnectionConfig) = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            _uiState.update { it.copy(connected = true, connecting = false, error = null) }
            _uiState.value.selectedSessionId?.let { client.joinSession(webSocket, it) }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            runCatching { json.decodeFromString<WsEvent>(text) }
                .onSuccess(::handleEvent)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            _uiState.update { it.copy(connected = false, error = t.message) }
            scope.launch {
                kotlinx.coroutines.delay(2_000)
                if (_uiState.value.connection == config) connect(config)
            }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            _uiState.update { it.copy(connected = false) }
        }
    }

    private fun handleEvent(event: WsEvent) {
        val payload = event.payload ?: return
        val eventSessionId = payload["sessionId"]?.jsonPrimitive?.contentOrNull
        val currentSessionId = _uiState.value.selectedSessionId
        val belongsToOtherSession = eventSessionId != null && eventSessionId != currentSessionId
        if (belongsToOtherSession && event.type != "room:timeline" && event.type != "ag-ui:event") return

        when (event.type) {
            "agent:typing" -> _uiState.update { it.copy(agentTyping = true) }
            "message:stream" -> {
                val messageId = payload["messageId"]?.jsonPrimitive?.content ?: return
                val delta = payload["delta"]?.jsonPrimitive?.content.orEmpty()
                _uiState.update { state ->
                    val existing = state.streamingMessage
                    val next = if (existing?.id == messageId) {
                        existing.copy(content = existing.content + delta)
                    } else {
                        Message(
                            id = messageId,
                            sessionId = currentSessionId.orEmpty(),
                            senderType = "agent",
                            content = delta,
                        )
                    }
                    state.copy(streamingMessage = next, agentTyping = true)
                }
            }
            "message:metadata" -> {
                val messageId = payload["messageId"]?.jsonPrimitive?.content ?: return
                val codeAgentRun = payload["codeAgentRun"] as? kotlinx.serialization.json.JsonObject ?: return
                _uiState.update { state ->
                    val current = state.streamingMessage
                    val next = if (current?.id == messageId) {
                        current
                    } else {
                        Message(
                            id = messageId,
                            sessionId = currentSessionId.orEmpty(),
                            senderType = "agent",
                            content = current?.content.orEmpty(),
                        )
                    }
                    state.copy(
                        streamingMessage = next,
                        streamingCodeAgentRun = codeAgentRun,
                        agentTyping = true,
                    )
                }
            }
            "message:completed" -> {
                val messageElement = payload["message"] ?: return
                val message = json.decodeFromJsonElement<Message>(messageElement)
                _uiState.update {
                    it.copy(
                        messages = it.messages.filterNot { item -> item.id == message.id } + message,
                        streamingMessage = null,
                        streamingCodeAgentRun = null,
                        agentTyping = false,
                    )
                }
                refreshSessions()
            }
            "message:cancelled" -> _uiState.update {
                it.copy(streamingMessage = null, streamingCodeAgentRun = null, agentTyping = false)
            }
            "room:timeline" -> handleRoomTimelineEvent(payload, eventSessionId, currentSessionId)
            "ag-ui:event" -> {
                refreshSessions()
                refreshWorkbench()
            }
        }
    }

    private fun handleRoomTimelineEvent(
        payload: JsonObject,
        eventSessionId: String?,
        currentSessionId: String?,
    ) {
        val sessionId = eventSessionId ?: return
        if (sessionId != currentSessionId) {
            refreshSessions()
            return
        }
        val config = _uiState.value.connection ?: return
        val roomEvent = payload["event"] as? JsonObject
        val senderType = roomEvent?.get("senderType")?.jsonPrimitive?.contentOrNull
        val eventType = roomEvent?.get("type")?.jsonPrimitive?.contentOrNull
        val metadata = roomEvent?.get("metadata") as? JsonObject
        val hiddenFromChat = metadata?.get("hiddenFromChat")?.jsonPrimitive?.booleanOrNull == true
        val clearTyping = !hiddenFromChat && (senderType == "manager" || senderType == "worker" || senderType == "system")
        if (senderType == "human" && eventType == "human.message") {
            _uiState.update { it.copy(agentTyping = true) }
        }
        scheduleSelectedMessageRefresh(config, sessionId, clearTyping)
    }

    private fun scheduleSelectedMessageRefresh(
        config: ConnectionConfig,
        sessionId: String,
        clearTyping: Boolean,
    ) {
        messageRefreshJob?.cancel()
        messageRefreshJob = scope.launch {
            delay(150)
            runCatching { client.listMessages(config, sessionId) }
                .onSuccess { messages ->
                    _uiState.update { state ->
                        if (state.selectedSessionId != sessionId) {
                            state
                        } else {
                            state.copy(
                                messages = messages,
                                streamingMessage = null,
                                streamingCodeAgentRun = null,
                                agentTyping = if (clearTyping) false else state.agentTyping,
                                error = null,
                            )
                        }
                    }
                    refreshSessions()
                }
                .onFailure { error -> _uiState.update { it.copy(error = error.message) } }
        }
    }

    private fun applySync(sync: MobileSyncResponse) {
        _uiState.update { state ->
            val selectedSessionId = state.selectedSessionId
                ?.takeIf { id -> sync.sessions.any { session -> session.id == id } }
            state.copy(
                currentUser = sync.currentUser,
                sessions = sync.sessions,
                workspaces = sync.workspaces,
                agents = sync.agents,
                contacts = sync.contacts,
                liveContacts = sync.liveContacts,
                selectedSessionId = selectedSessionId,
                messages = if (selectedSessionId == null && state.selectedSessionId != null) emptyList() else state.messages,
                streamingMessage = if (selectedSessionId == null && state.selectedSessionId != null) null else state.streamingMessage,
                error = null,
            )
        }
    }

    private fun startSyncLoop(config: ConnectionConfig) {
        syncJob?.cancel()
        syncJob = scope.launch {
            while (_uiState.value.connection == config) {
                delay(8_000)
                runCatching { client.sync(config) }
                    .onSuccess { sync -> applySync(sync) }
            }
        }
    }

    private fun pairingBaseUrlCandidates(payload: PairingPayload): List<String> {
        return (listOf(payload.baseUrl) + payload.baseUrls)
            .map { it.trim().trimEnd('/') }
            .filter { it.startsWith("http://") || it.startsWith("https://") }
            .filterNot { it.startsWith("http://10.0.2.2") || it.startsWith("https://10.0.2.2") }
            .distinct()
    }
}
