package com.agenthub.mobile.data

import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
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

    fun connect(config: ConnectionConfig) {
        scope.launch {
            _uiState.update {
                it.copy(connection = config, connecting = true, error = null)
            }
            runCatching {
                client.health(config)
                val sessions = client.listSessions(config)
                currentSocket?.cancel()
                currentSocket = client.openEventSocket(config, socketListener(config))
                _uiState.update {
                    it.copy(
                        sessions = sessions,
                        selectedSessionId = it.selectedSessionId,
                        connecting = false,
                        connected = true,
                    )
                }
                _uiState.value.selectedSessionId?.let { selectSession(it) }
            }.onFailure { error ->
                _uiState.update {
                    it.copy(connecting = false, connected = false, error = error.message ?: "Connection failed")
                }
            }
        }
    }

    fun disconnect() {
        currentSocket?.cancel()
        currentSocket = null
        _uiState.update {
            MobileUiState()
        }
    }

    fun refreshSessions() {
        val config = _uiState.value.connection ?: return
        scope.launch {
            runCatching { client.listSessions(config) }
                .onSuccess { sessions -> _uiState.update { it.copy(sessions = sessions, error = null) } }
                .onFailure { error -> _uiState.update { it.copy(error = error.message) } }
        }
    }

    suspend fun confirmPairing(payload: PairingPayload): PairConfirmResponse {
        _uiState.update { it.copy(connecting = true, error = null) }
        return try {
            client.confirmPairing(payload).also {
                _uiState.update { state -> state.copy(connecting = false, error = null) }
            }
        } catch (error: Throwable) {
            _uiState.update { it.copy(connecting = false, error = error.message ?: "配对失败") }
            throw error
        }
    }

    fun setError(message: String) {
        _uiState.update { it.copy(connecting = false, error = message) }
    }

    fun createSession(title: String = "新会话") {
        val config = _uiState.value.connection ?: return
        scope.launch {
            runCatching { client.createSession(config, title) }
                .onSuccess { session ->
                    _uiState.update { it.copy(sessions = listOf(session) + it.sessions) }
                    selectSession(session.id)
                }
                .onFailure { error -> _uiState.update { it.copy(error = error.message) } }
        }
    }

    fun selectSession(sessionId: String) {
        val config = _uiState.value.connection ?: return
        _uiState.update {
            it.copy(selectedSessionId = sessionId, messages = emptyList(), streamingMessage = null, agentTyping = false)
        }
        currentSocket?.let { client.joinSession(it, sessionId) }
        scope.launch {
            runCatching { client.listMessages(config, sessionId) }
                .onSuccess { messages -> _uiState.update { it.copy(messages = messages, error = null) } }
                .onFailure { error -> _uiState.update { it.copy(error = error.message) } }
        }
    }

    fun sendMessage(content: String) {
        val config = _uiState.value.connection ?: return
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
        val eventSessionId = payload["sessionId"]?.jsonPrimitive?.content
        val currentSessionId = _uiState.value.selectedSessionId
        if (eventSessionId != null && eventSessionId != currentSessionId) return

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
            "message:completed" -> {
                val messageElement = payload["message"] ?: return
                val message = json.decodeFromJsonElement<Message>(messageElement)
                _uiState.update {
                    it.copy(
                        messages = it.messages.filterNot { item -> item.id == message.id } + message,
                        streamingMessage = null,
                        agentTyping = false,
                    )
                }
                refreshSessions()
            }
            "message:cancelled" -> _uiState.update {
                it.copy(streamingMessage = null, agentTyping = false)
            }
        }
    }
}
