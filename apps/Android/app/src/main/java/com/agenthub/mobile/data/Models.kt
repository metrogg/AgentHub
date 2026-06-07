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
    val metadata: JsonObject? = null,
    val lastMessage: SessionLastMessage? = null,
    val createdAt: String = "",
    val updatedAt: String = "",
)

@Serializable
data class SessionLastMessage(
    val content: String = "",
    val senderType: String = "",
)

@Serializable
data class MobileUserProfile(
    val id: String = "",
    val name: String = "You",
    val avatar: String? = null,
)

@Serializable
data class Workspace(
    val id: String,
    val ownerId: String = "",
    val name: String = "",
    val goal: String = "",
    val projectPath: String? = null,
    val createdAt: String = "",
    val updatedAt: String = "",
)

@Serializable
data class WorkspaceAgent(
    val id: String,
    val workspaceId: String,
    val name: String = "",
    val role: String = "",
    val roleType: String = "custom",
    val description: String = "",
    val avatar: String? = null,
    val systemPrompt: String = "",
    val roleProfile: JsonObject? = null,
    val color: String = "",
    val modelId: String? = null,
    val runtimeType: String = "llm",
    val codeAgentType: String? = null,
    val capabilityTags: List<String> = emptyList(),
    val toolPermissions: List<String> = emptyList(),
    val sandboxPolicy: String = "workspace-write",
    val contextPolicy: String = "workspace-aware",
    val autoInvoke: Boolean = true,
    val approvalRequired: Boolean = true,
    val orderIdx: Int = 0,
    val createdAt: String = "",
)

@Serializable
data class AgentContact(
    val id: String,
    val source: String = "library",
    val workspaceId: String? = null,
    val workspaceAgentId: String? = null,
    val name: String = "",
    val role: String = "",
    val roleType: String = "custom",
    val description: String = "",
    val avatar: String? = null,
    val color: String = "",
    val runtimeType: String = "llm",
    val codeAgentType: String? = null,
    val capabilityTags: List<String> = emptyList(),
    val observedState: String? = null,
    val desiredState: String? = null,
    val lastHeartbeatAt: String? = null,
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
data class MobileSyncResponse(
    val sessions: List<Session> = emptyList(),
    val workspaces: List<Workspace> = emptyList(),
    val agents: List<WorkspaceAgent> = emptyList(),
    val contacts: List<AgentContact> = emptyList(),
    val liveContacts: List<AgentContact> = emptyList(),
    val currentUser: MobileUserProfile = MobileUserProfile(),
)

@Serializable
data class MobileWorkbenchRuntime(
    val provider: String = "openai",
    val model: String = "",
    val baseUrl: String = "",
    val source: String = "",
    val apiKeyConfigured: Boolean = false,
    val apiKeySource: String? = null,
)

@Serializable
data class MobileWorkbenchCodingToolItem(
    val id: String,
    val name: String,
    val command: String,
    val installed: Boolean = false,
    val configured: Boolean = false,
    val executionEnabled: Boolean = false,
    val ready: Boolean = false,
    val version: String? = null,
    val configEnv: String? = null,
    val configMessage: String = "",
    val readiness: String = "",
    val docsHint: String = "",
)

@Serializable
data class MobileWorkbenchCodingTools(
    val platform: String = "",
    val localCliProbesEnabled: Boolean = true,
    val executionEnabled: Boolean = true,
    val items: List<MobileWorkbenchCodingToolItem> = emptyList(),
)

@Serializable
data class MobileWorkbenchSkillSummary(
    val id: String,
    val name: String,
    val description: String = "",
    val rootPath: String = "",
    val skillPath: String = "",
    val source: String = "",
)

@Serializable
data class MobileWorkbenchOfficeStatus(
    val url: String = "",
    val root: String = "",
    val rootExists: Boolean = false,
    val running: Boolean = false,
    val starting: Boolean = false,
    val started: Boolean = false,
    val pid: Int? = null,
    val error: String? = null,
)

@Serializable
data class MobileWorkbenchConnectivityStatus(
    val port: Int = 0,
    val localAddresses: List<String> = emptyList(),
    val baseUrls: List<String> = emptyList(),
    val message: String = "",
)

@Serializable
data class MobileWorkbenchWorkspaceSummary(
    val id: String,
    val name: String = "",
    val goal: String = "",
    val projectPath: String? = null,
    val agentCount: Int = 0,
    val taskCount: Int = 0,
    val sessionCount: Int = 0,
    val activeRunCount: Int = 0,
    val groupSessionId: String? = null,
    val updatedAt: String = "",
)

@Serializable
data class MobileWorkbenchRunSummary(
    val id: String,
    val workspaceId: String,
    val workspaceName: String = "",
    val groupSessionId: String = "",
    val sessionTitle: String = "",
    val status: String = "",
    val conflictCount: Int = 0,
    val createdAt: String = "",
    val updatedAt: String = "",
)

@Serializable
data class MobileWorkbenchTaskSummary(
    val id: String,
    val workspaceId: String,
    val workspaceName: String = "",
    val runId: String? = null,
    val groupSessionId: String? = null,
    val sessionId: String? = null,
    val sessionTitle: String = "",
    val agentId: String? = null,
    val agentName: String = "",
    val agentRole: String = "",
    val title: String = "",
    val description: String = "",
    val status: String = "",
    val progressPercent: Int = 0,
    val progressStatus: String = "",
    val phaseId: String? = null,
    val orderIdx: Int = 0,
    val requiresAttention: Boolean = false,
    val createdAt: String = "",
    val updatedAt: String = "",
    val startedAt: String? = null,
    val completedAt: String? = null,
    val errorLog: String? = null,
)

@Serializable
data class MobileWorkbenchResponse(
    val generatedAt: String = "",
    val runtime: MobileWorkbenchRuntime = MobileWorkbenchRuntime(),
    val codingTools: MobileWorkbenchCodingTools = MobileWorkbenchCodingTools(),
    val skills: List<MobileWorkbenchSkillSummary> = emptyList(),
    val office: MobileWorkbenchOfficeStatus = MobileWorkbenchOfficeStatus(),
    val connectivity: MobileWorkbenchConnectivityStatus = MobileWorkbenchConnectivityStatus(),
    val workspaces: List<MobileWorkbenchWorkspaceSummary> = emptyList(),
    val runs: List<MobileWorkbenchRunSummary> = emptyList(),
    val tasks: List<MobileWorkbenchTaskSummary> = emptyList(),
)

@Serializable
data class WorkbenchActionResponse(
    val ok: Boolean = true,
    val status: String? = null,
    val message: String = "",
)

@Serializable
data class TestModelRequest(
    val provider: String? = null,
    val apiEndpoint: String? = null,
    val anthropicEndpoint: String? = null,
    val apiKey: String? = null,
    val apiKeyEnv: String? = null,
    val modelId: String? = null,
)

@Serializable
data class TestModelResponse(
    val ok: Boolean = false,
    val message: String = "",
    val model: String? = null,
    val latencyMs: Long? = null,
)

@Serializable
data class SettingsResponse(
    val settings: Map<String, String> = emptyMap(),
)

@Serializable
data class SessionResponse(
    val session: Session,
)

@Serializable
data class WorkspaceFullResponse(
    val workspace: Workspace? = null,
    val agents: List<WorkspaceAgent> = emptyList(),
)

@Serializable
data class CreateSessionRequest(
    val title: String,
    val type: String = "direct",
    val workspaceId: String? = null,
    val workspaceAgentId: String? = null,
)

@Serializable
data class GroupSessionRequest(
    val agentIds: List<String> = emptyList(),
    val title: String? = null,
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
    val currentUser: MobileUserProfile = MobileUserProfile(),
    val sessions: List<Session> = emptyList(),
    val workspaces: List<Workspace> = emptyList(),
    val agents: List<WorkspaceAgent> = emptyList(),
    val contacts: List<AgentContact> = emptyList(),
    val liveContacts: List<AgentContact> = emptyList(),
    val messages: List<Message> = emptyList(),
    val selectedSessionId: String? = null,
    val archivedSessionIds: Set<String> = emptySet(),
    val streamingMessage: Message? = null,
    val streamingCodeAgentRun: JsonObject? = null,
    val workbench: MobileWorkbenchResponse? = null,
    val workbenchLoading: Boolean = false,
    val settings: Map<String, String> = emptyMap(),
    val settingsLoading: Boolean = false,
    val testModelResult: TestModelResponse? = null,
    val agentTyping: Boolean = false,
    val connecting: Boolean = false,
    val connected: Boolean = false,
    val error: String? = null,
) {
    val selectedSession: Session?
        get() = sessions.firstOrNull { it.id == selectedSessionId }
}
