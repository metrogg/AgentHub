package com.agenthub.mobile.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
data class ConnectionConfig(
    val baseUrl: String,
    val deviceName: String = "Android",
    val authToken: String? = null,
)

@Serializable
data class PairingPayload(
    val version: Int = 1,
    val baseUrl: String,
    val baseUrls: List<String> = emptyList(),
    val webUrl: String? = null,
    val webUrls: List<String> = emptyList(),
    val pairingCode: String,
    val expiresAt: String,
)

@Serializable
data class PairConfirmRequest(
    val pairingCode: String,
    val deviceName: String = "Android",
)

@Serializable
data class PairConfirmResponse(
    val baseUrl: String,
    val webUrl: String? = null,
    val deviceName: String = "Android",
    val authToken: String? = null,
    val expiresAt: String? = null,
)

@Serializable
data class Session(
    val id: String,
    val ownerId: String = "",
    val title: String = "",
    val type: String = "direct",
    val workspaceId: String? = null,
    val workspaceAgentId: String? = null,
    val createdAt: String = "",
    val updatedAt: String = "",
)

@Serializable
data class Message(
    val id: String,
    val sessionId: String,
    val senderId: String = "",
    val senderType: String = "system",
    val type: String = "text",
    val content: String = "",
    val metadata: JsonObject? = null,
    val createdAt: String = "",
)

@Serializable
data class ListResponse<T>(
    val items: List<T> = emptyList(),
)

@Serializable
data class CreateSessionRequest(
    val title: String,
    val type: String = "direct",
    val workspaceId: String? = null,
    val workspaceAgentId: String? = null,
)

@Serializable
data class SendMessageRequest(
    val content: String,
    val type: String = "text",
    val clientMessageId: String? = null,
)

@Serializable
data class WsEvent(
    val type: String,
    val payload: JsonObject? = null,
)

@Serializable
data class JoinSessionCommand(
    val type: String = "session:join",
    val payload: JoinSessionPayload,
)

@Serializable
data class JoinSessionPayload(
    val sessionId: String,
)

data class MobileUiState(
    val connection: ConnectionConfig? = null,
    val sessions: List<Session> = emptyList(),
    val messages: List<Message> = emptyList(),
    val selectedSessionId: String? = null,
    val streamingMessage: Message? = null,
    val agentTyping: Boolean = false,
    val connecting: Boolean = false,
    val connected: Boolean = false,
    val error: String? = null,
) {
    val selectedSession: Session?
        get() = sessions.firstOrNull { it.id == selectedSessionId }
}
