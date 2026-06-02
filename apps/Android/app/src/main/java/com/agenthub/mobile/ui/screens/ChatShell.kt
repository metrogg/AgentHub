package com.agenthub.mobile.ui.screens

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.ExperimentalAnimationApi
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.agenthub.mobile.R
import com.agenthub.mobile.data.Message
import com.agenthub.mobile.data.MobileUserProfile
import com.agenthub.mobile.data.MobileUiState
import com.agenthub.mobile.data.Session
import com.agenthub.mobile.data.AgentContact
import com.agenthub.mobile.data.MobileWorkbenchCodingToolItem
import com.agenthub.mobile.data.MobileWorkbenchRunSummary
import com.agenthub.mobile.data.MobileWorkbenchSkillSummary
import com.agenthub.mobile.data.MobileWorkbenchTaskSummary
import com.agenthub.mobile.data.MobileWorkbenchWorkspaceSummary
import com.agenthub.mobile.data.TestModelRequest
import com.agenthub.mobile.data.Workspace
import com.agenthub.mobile.data.WorkspaceAgent
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.net.URLEncoder
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonArray

// Telegram-inspired dark palette
private val Hairline = Color(0xFF253343)
private val PageBackground = Color(0xFF121B24)
private val PanelBackground = Color(0xFF1B2530)
private val PanelElevated = Color(0xFF22303D)
private val Ink = Color(0xFFF4F7FA)
private val MutedText = Color(0xFF92A0AE)
private val TgBlue = Color(0xFF4EA2F6)
private val TgBlueLight = Color(0xFF223648)
private val TgGreen = Color(0xFF55D66B)
private val TgSentBg = Color(0xFF4B83E4)
private val TgReceivedBg = Color(0xFF1D2834)
private val TgChatBg = Color(0xFF0D1620)
private val SessionCardSurface = Color(0xFF24232D)
private val SoftFill = Color(0xFF22303F)
private val WorkAmber = Color(0xFFFFB04A)
private val ProfileGreenSoft = Color(0xFF162A20)
private val ProfileBlue = Color(0xFF4EA2F6)
private val TgUnreadBg = Color(0xFF4EA2F6)
private val TgOnlineGreen = Color(0xFF55D66B)
private val BottomGlass = Color(0xE616212D)

private enum class MobileTab(val label: String, val iconRes: Int) {
    Messages("消息", R.drawable.ic_mobile_tab_chat),
    Agents("通讯录", R.drawable.ic_mobile_tab_agents),
    Workbench("工作台", R.drawable.ic_mobile_tab_workbench),
    Me("设置", R.drawable.ic_mobile_tab_me),
}

private enum class LineIconKind {
    Search,
    Chat,
    Agents,
    Bot,
    History,
    Logs,
    Tools,
    Skills,
    Office,
    Send,
    File,
    Image,
    Web,
    Document,
    Presentation,
    Diff,
    Workflow,
    Info,
    Scan,
    Disconnect,
    Archive,
    Delete,
    Refresh,
    Pin,
}

@OptIn(ExperimentalAnimationApi::class)
@Composable
fun ChatShell(
    state: MobileUiState,
    onDisconnect: () -> Unit,
    onRefresh: () -> Unit,
    onCreateSession: () -> Unit,
    onOpenWorkspaceGroupSession: (String) -> Unit,
    onCreateGroupSession: (List<String>, String?) -> Unit,
    onOpenAgentContact: (AgentContact) -> Unit,
    onSelectSession: (String) -> Unit,
    onSendMessage: (String) -> Unit,
    onArchiveSession: (String) -> Unit,
    onUnarchiveSession: (String) -> Unit,
    onDeleteSession: (String) -> Unit,
    onStartOffice: () -> Unit,
    onOpenFirewall: () -> Unit,
    onInstallCodingTools: () -> Unit,
    onRepairCodingTools: () -> Unit,
    onScanPairingQr: (String) -> Unit,
    onFetchSettings: () -> Unit,
    onUpdateSettings: (Map<String, String>) -> Unit,
    onTestModel: (TestModelRequest) -> Unit,
    onClearTestModelResult: () -> Unit,
) {
    var currentTab by remember { mutableStateOf(MobileTab.Messages) }
    var showSessions by remember { mutableStateOf(true) }
    var settingsSubScreen by remember { mutableStateOf<String?>(null) }
    var showNewGroupSheet by remember { mutableStateOf(false) }
    val qrLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents
        if (!contents.isNullOrBlank()) onScanPairingQr(contents)
    }

    fun scanQr() {
        qrLauncher.launch(
            ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt("扫描电脑端 AgentHub 二维码")
                .setBeepEnabled(false)
                .setOrientationLocked(false),
        )
    }

    LaunchedEffect(state.selectedSessionId) {
        if (state.selectedSessionId != null) {
            currentTab = MobileTab.Messages
            showSessions = false
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(PageBackground),
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
        MobileTopBar(
            state = state,
            title = when {
                currentTab == MobileTab.Me && settingsSubScreen != null -> when (settingsSubScreen) {
                    "model-management" -> "模型管理"
                    "coding-tools" -> "Coding Tools"
                    "skills-market" -> "Skills 市场"
                    "office" -> "办公室"
                    else -> currentTab.label
                }
                currentTab != MobileTab.Messages -> currentTab.label
                showSessions -> "消息"
                else -> state.selectedSession?.title.orEmpty().ifBlank { "对话" }
            },
            connected = state.connected,
            showBack = (currentTab == MobileTab.Messages && !showSessions) ||
                (currentTab == MobileTab.Me && settingsSubScreen != null),
            conversationMode = currentTab == MobileTab.Messages && !showSessions,
            currentSession = state.selectedSession,
            onBack = {
                if (currentTab == MobileTab.Me && settingsSubScreen != null) {
                    settingsSubScreen = null
                } else {
                    showSessions = true
                }
            },
            onCreateSession = { showNewGroupSheet = true },
            onRefresh = onRefresh,
            onScanQr = ::scanQr,
            onOpenSessions = { showSessions = true },
            onOpenSessionFromSettings = { sessionId ->
                onSelectSession(sessionId)
                showSessions = false
            },
            onArchiveCurrent = { sessionId ->
                onArchiveSession(sessionId)
                showSessions = true
            },
            onUnarchiveCurrent = { sessionId ->
                onUnarchiveSession(sessionId)
                showSessions = true
            },
            onDeleteCurrent = { sessionId ->
                onDeleteSession(sessionId)
                showSessions = true
            },
        )
        AnimatedVisibility(
            visible = !state.error.isNullOrBlank(),
            enter = slideInVertically { -it } + fadeIn(),
            exit = fadeOut(),
        ) {
            Text(
                text = state.error.orEmpty(),
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0xFF3A1F25))
                    .padding(horizontal = 18.dp, vertical = 8.dp),
                color = Color(0xFFFF7B86),
                fontSize = 12.sp,
            )
        }

        Box(modifier = Modifier.weight(1f)) {
            AnimatedContent(
                targetState = currentTab,
                transitionSpec = {
                    (fadeIn() + slideInHorizontally { it / 5 }).togetherWith(fadeOut())
                        .using(SizeTransform(clip = false))
                },
                label = "tab-transition",
            ) { tab ->
                when (tab) {
                    MobileTab.Messages -> MessageArea(
                        state = state,
                        showSessions = showSessions,
                        onShowSessions = { showSessions = true },
                        onOpenConversation = {
                            onSelectSession(it.id)
                            showSessions = false
                        },
                        onRefresh = onRefresh,
                        onCreateSession = { showNewGroupSheet = true },
                        onSendMessage = onSendMessage,
                        onArchiveSession = onArchiveSession,
                        onUnarchiveSession = onUnarchiveSession,
                        onDeleteSession = onDeleteSession,
                    )
                    MobileTab.Agents -> AgentDirectoryScreen(
                        state = state,
                        onOpenAgentContact = onOpenAgentContact,
                        onRefresh = onRefresh,
                    )
                    MobileTab.Workbench -> WorkbenchScreenV2(
                        state = state,
                        onRefresh = onRefresh,
                        onCreateSession = { showNewGroupSheet = true },
                        onOpenWorkspaceGroupSession = onOpenWorkspaceGroupSession,
                    )
                    MobileTab.Me -> {
                        val subScreen = settingsSubScreen
                        when (subScreen) {
                            "model-management" -> ModelManagementScreen(
                                state = state,
                                onBack = { settingsSubScreen = null },
                                onFetchSettings = onFetchSettings,
                                onUpdateSettings = onUpdateSettings,
                                onTestModel = onTestModel,
                                onClearTestResult = onClearTestModelResult,
                                onRefresh = onRefresh,
                            )
                            "coding-tools" -> CodingToolsScreen(
                                state = state,
                                onBack = { settingsSubScreen = null },
                                onInstall = onInstallCodingTools,
                                onRepair = onRepairCodingTools,
                                onRefresh = onRefresh,
                            )
                            "skills-market" -> SkillsMarketScreen(
                                state = state,
                                onBack = { settingsSubScreen = null },
                                onRefresh = onRefresh,
                            )
                            "office" -> OfficeScreen(
                                state = state,
                                onBack = { settingsSubScreen = null },
                                onStartOffice = onStartOffice,
                                onOpenFirewall = onOpenFirewall,
                                onRefresh = onRefresh,
                            )
                            else -> ProfileScreen(
                                state = state,
                                onDisconnect = onDisconnect,
                                onScanQr = ::scanQr,
                                onRefresh = onRefresh,
                                onOpenModelManagement = { settingsSubScreen = "model-management" },
                                onOpenCodingTools = { settingsSubScreen = "coding-tools" },
                                onOpenSkillsMarket = { settingsSubScreen = "skills-market" },
                                onOpenOffice = { settingsSubScreen = "office" },
                            )
                        }
                    }
                }
            }
            if (showSessions || currentTab != MobileTab.Messages) {
                MainTabBar(
                    modifier = Modifier.align(Alignment.BottomCenter),
                    active = currentTab,
                    onSelect = { selected ->
                        currentTab = selected
                        if (selected == MobileTab.Messages) showSessions = true
                        settingsSubScreen = null
                    },
                )
            }
        }
        }

        if (showNewGroupSheet) {
            NewGroupChatSheet(
                state = state,
                onDismiss = { showNewGroupSheet = false },
                onStart = { agentIds, title ->
                    showNewGroupSheet = false
                    showSessions = false
                    onCreateGroupSession(agentIds, title)
                },
                onFallbackCreate = {
                    showNewGroupSheet = false
                    onCreateSession()
                },
            )
        }
    }
}

@Composable
private fun MobileTopBar(
    state: MobileUiState,
    title: String,
    connected: Boolean,
    showBack: Boolean,
    conversationMode: Boolean,
    currentSession: Session?,
    onBack: () -> Unit,
    onCreateSession: () -> Unit,
    onRefresh: () -> Unit,
    onScanQr: () -> Unit,
    onOpenSessions: () -> Unit,
    onOpenSessionFromSettings: (String) -> Unit,
    onArchiveCurrent: (String) -> Unit,
    onUnarchiveCurrent: (String) -> Unit,
    onDeleteCurrent: (String) -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }
    val currentArchived = currentSession?.id?.let { state.archivedSessionIds.contains(it) } == true
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(if (showBack) 68.dp else 74.dp)
                .background(PageBackground)
                .padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (showBack) {
                TopIconButton(label = "‹", onClick = onBack)
                Spacer(modifier = Modifier.width(10.dp))
                Box(
                    modifier = Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(PanelElevated),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        currentSession?.title?.take(1)?.uppercase().orEmpty().ifBlank { "A" },
                        color = Ink,
                        fontWeight = FontWeight.Bold,
                        fontSize = 15.sp,
                    )
                }
                Spacer(modifier = Modifier.width(12.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        title,
                        color = Ink,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 18.sp,
                        maxLines = 1,
                    )
                    Text(
                        if (connected) "已同步" else "连接中...",
                        color = if (connected) TgOnlineGreen else MutedText,
                        fontSize = 12.sp,
                        maxLines = 1,
                    )
                }
            } else {
                Column(modifier = Modifier.weight(1f)) {
                    Text(title, color = Ink, fontWeight = FontWeight.Bold, fontSize = 24.sp, maxLines = 1)
                    Text(
                        if (connected) "已同步到电脑端" else "等待连接电脑端",
                        color = if (connected) TgOnlineGreen else MutedText,
                        fontSize = 13.sp,
                        maxLines = 1,
                    )
                }
            }

            Box(modifier = Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                TopBarActionButton(
                    onClick = { menuOpen = true },
                    conversationMode = conversationMode,
                )
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    if (conversationMode) {
                        DropdownMenuItem(text = { Text("会话设置") }, onClick = {
                            menuOpen = false
                            showSettings = true
                        })
                        DropdownMenuItem(text = { Text("回到会话列表") }, onClick = {
                            menuOpen = false
                            onOpenSessions()
                        })
                        DropdownMenuItem(text = { Text(if (currentArchived) "移出归档" else "归档会话") }, onClick = {
                            menuOpen = false
                            currentSession?.id?.let { sessionId ->
                                if (currentArchived) onUnarchiveCurrent(sessionId) else onArchiveCurrent(sessionId)
                            }
                        })
                        DropdownMenuItem(text = { Text("删除会话") }, onClick = {
                            menuOpen = false
                            confirmDelete = true
                        })
                        DropdownMenuItem(text = { Text("同步会话") }, onClick = {
                            menuOpen = false
                            onRefresh()
                        })
                    } else {
                        DropdownMenuItem(text = { Text("发起群聊") }, onClick = {
                            menuOpen = false
                            onCreateSession()
                        })
                        DropdownMenuItem(text = { Text("扫一扫") }, onClick = {
                            menuOpen = false
                            onScanQr()
                        })
                        DropdownMenuItem(text = { Text("同步会话") }, onClick = {
                            menuOpen = false
                            onRefresh()
                        })
                    }
                }
            }
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(0.5.dp)
                .background(Hairline),
        )
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("删除会话") },
            text = { Text("会话和消息会从电脑端删除，此操作不可撤销。") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    currentSession?.id?.let(onDeleteCurrent)
                }) {
                    Text("删除", color = Color(0xFFB42318))
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) {
                    Text("取消")
                }
            },
        )
    }

    if (showSettings && currentSession != null) {
        ConversationSettingsDialog(
            state = state,
            session = currentSession,
            connected = connected,
            onDismiss = { showSettings = false },
            onOpenSessionFromSettings = onOpenSessionFromSettings,
            onRefresh = {
                showSettings = false
                onRefresh()
            },
            onArchive = {
                showSettings = false
                onArchiveCurrent(currentSession.id)
            },
            onUnarchive = {
                showSettings = false
                onUnarchiveCurrent(currentSession.id)
            },
            onRequestDelete = {
                showSettings = false
                confirmDelete = true
            },
        )
    }
}

@Composable
private fun ConversationSettingsDialog(
    state: MobileUiState,
    session: Session,
    connected: Boolean,
    onDismiss: () -> Unit,
    onOpenSessionFromSettings: (String) -> Unit,
    onRefresh: () -> Unit,
    onArchive: () -> Unit,
    onUnarchive: () -> Unit,
    onRequestDelete: () -> Unit,
) {
    val archived = state.archivedSessionIds.contains(session.id)
    val workspace = state.workspaces.firstOrNull { it.id == session.workspaceId }
    val workspaceAgents = state.agents.filter { it.workspaceId == session.workspaceId }
    val memberAgents = remember(session, workspaceAgents) { groupSessionAgents(session, workspaceAgents) }
    val childSessions = remember(session, state.sessions) {
        state.sessions.filter { child ->
            child.id != session.id &&
                child.workspaceId == session.workspaceId &&
                child.metadata?.stringValue("kind") == "orchestrator-task"
        }
    }
    val artifactCount = remember(
        state.messages,
        state.streamingMessage,
        state.streamingCodeAgentRun,
        session.workspaceId,
    ) {
        val normal = state.messages.flatMap { readArtifacts(it.metadata, null, session.workspaceId) }
        val streaming = state.streamingMessage?.let {
            readArtifacts(it.metadata, state.streamingCodeAgentRun, session.workspaceId)
        }.orEmpty()
        (normal + streaming).distinctBy { it.id }.size
    }
    val latestPreview = sessionPreviewText(session)
    val sessionKind = sessionKindLabel(session)

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = PanelBackground,
        title = {
            Text(
                "会话设置",
                color = Ink,
                fontWeight = FontWeight.SemiBold,
                fontSize = 18.sp,
            )
        },
        text = {
            LazyColumn(
                modifier = Modifier.heightIn(max = 560.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item {
                    ConversationSettingsHero(
                        session = session,
                        connected = connected,
                        archived = archived,
                        workspaceName = workspace?.name,
                    )
                }
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        ConversationMetricTile("消息", state.messages.size.toString(), Modifier.weight(1f))
                        ConversationMetricTile("产物", artifactCount.toString(), Modifier.weight(1f))
                        ConversationMetricTile("成员", memberCountLabel(session, memberAgents, childSessions.size), Modifier.weight(1f))
                    }
                }
                item {
                    ConversationSettingsSection("会话信息", "当前会话在桌面端同步的基础资料") {
                        SettingsInfoRow("名称", session.title.ifBlank { "未命名会话" })
                        SettingsInfoRow("类型", sessionKind)
                        SettingsInfoRow("状态", if (archived) "已归档" else "正常显示")
                        SettingsInfoRow("同步", if (connected) "已同步到电脑端" else "等待连接")
                        if (!workspace?.name.isNullOrBlank()) SettingsInfoRow("工作区", workspace!!.name)
                        if (!workspace?.projectPath.isNullOrBlank()) {
                            SettingsInfoRow("项目", workspace!!.projectPath.orEmpty())
                        }
                    }
                }
                item {
                    ConversationSettingsSection("最近内容", "用于确认当前打开的是哪条会话") {
                        Text(
                            latestPreview,
                            color = MutedText,
                            fontSize = 13.sp,
                            lineHeight = 18.sp,
                            maxLines = 3,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                        )
                    }
                }
                if (session.type == "group" || memberAgents.isNotEmpty()) {
                    item {
                        ConversationSettingsSection("群聊成员", "与桌面端会话成员保持一致") {
                            if (memberAgents.isEmpty()) {
                                ConversationEmptyText("暂无 Agent 成员，同步电脑端后会显示。")
                            } else {
                                memberAgents.take(6).forEach { agent ->
                                    ConversationAgentRow(agent = agent)
                                }
                                if (memberAgents.size > 6) {
                                    ConversationEmptyText("+${memberAgents.size - 6} 个成员")
                                }
                            }
                        }
                    }
                }
                if (childSessions.isNotEmpty()) {
                    item {
                        ConversationSettingsSection("任务子会话", "成员真实执行过程会沉淀在这里") {
                            childSessions.take(5).forEach { child ->
                                ConversationChildSessionRow(
                                    session = child,
                                    onClick = {
                                        onDismiss()
                                        onOpenSessionFromSettings(child.id)
                                    },
                                )
                            }
                            if (childSessions.size > 5) {
                                ConversationEmptyText("+${childSessions.size - 5} 个子会话")
                            }
                        }
                    }
                }
                item {
                    ConversationSettingsSection("会话管理", "参照桌面端会话侧栏的常用操作") {
                        ConversationSettingsActionRow(
                            icon = LineIconKind.Refresh,
                            label = "同步会话",
                            value = "刷新消息、成员和产物状态",
                            onClick = onRefresh,
                        )
                        ConversationSettingsDivider()
                        ConversationSettingsActionRow(
                            icon = LineIconKind.Archive,
                            label = if (archived) "移出归档" else "归档会话",
                            value = if (archived) "恢复到最近会话列表" else "从最近会话列表收起",
                            onClick = if (archived) onUnarchive else onArchive,
                        )
                    }
                }
                item {
                    ConversationSettingsSection("风险操作", "删除会同步影响电脑端会话记录") {
                        ConversationSettingsActionRow(
                            icon = LineIconKind.Delete,
                            label = "删除会话",
                            value = "删除会话和消息，此操作不可撤销",
                            danger = true,
                            onClick = onRequestDelete,
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text("关闭", color = MutedText)
            }
        },
    )
}

@Composable
private fun ConversationSettingsHero(
    session: Session,
    connected: Boolean,
    archived: Boolean,
    workspaceName: String?,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(PanelElevated)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SessionAvatar(session)
            Spacer(modifier = Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    session.title.ifBlank { "未命名会话" },
                    color = Ink,
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    listOfNotNull(
                        sessionKindLabel(session),
                        workspaceName?.takeIf { it.isNotBlank() },
                    ).joinToString(" · "),
                    modifier = Modifier.padding(top = 3.dp),
                    color = MutedText,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            WorkbenchChip(if (archived) "已归档" else if (connected) "已同步" else "离线")
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            WorkbenchChip(formatSessionTime(session.updatedAt).ifBlank { "刚刚" })
            WorkbenchChip(session.metadata?.stringValue("kind") ?: "normal")
        }
    }
}

@Composable
private fun ConversationMetricTile(label: String, value: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(PanelElevated)
            .padding(vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(value, color = TgBlue, fontWeight = FontWeight.Bold, fontSize = 17.sp, maxLines = 1)
        Text(label, modifier = Modifier.padding(top = 2.dp), color = MutedText, fontSize = 11.sp)
    }
}

@Composable
private fun ConversationSettingsSection(
    title: String,
    subtitle: String,
    content: @Composable () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(PanelElevated)
            .padding(vertical = 10.dp),
    ) {
        Text(
            title,
            modifier = Modifier.padding(horizontal = 12.dp),
            color = Ink,
            fontWeight = FontWeight.SemiBold,
            fontSize = 14.sp,
        )
        Text(
            subtitle,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 3.dp),
            color = MutedText,
            fontSize = 11.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Box(
            modifier = Modifier
                .padding(top = 6.dp)
                .fillMaxWidth()
                .height(0.5.dp)
                .background(Hairline),
        )
        Column { content() }
    }
}

@Composable
private fun ConversationSettingsActionRow(
    icon: LineIconKind,
    label: String,
    value: String,
    danger: Boolean = false,
    onClick: () -> Unit,
) {
    val accent = if (danger) Color(0xFFFF6B78) else TgBlue
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(accent.copy(alpha = 0.14f)),
            contentAlignment = Alignment.Center,
        ) {
            LineIcon(kind = icon, color = accent, modifier = Modifier.size(18.dp))
        }
        Spacer(modifier = Modifier.width(11.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(label, color = if (danger) accent else Ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            Text(
                value,
                modifier = Modifier.padding(top = 2.dp),
                color = MutedText,
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text("›", color = MutedText, fontSize = 18.sp)
    }
}

@Composable
private fun ConversationSettingsDivider() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 56.dp)
            .height(0.5.dp)
            .background(Hairline),
    )
}

@Composable
private fun ConversationAgentRow(agent: WorkspaceAgent) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(34.dp)
                .clip(CircleShape)
                .background(workspaceAgentAvatarColor(agent).copy(alpha = 0.22f))
                .border(1.dp, workspaceAgentAvatarColor(agent), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(workspaceAgentAvatarLabel(agent), color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(modifier = Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(agent.name.ifBlank { "Agent" }, color = Ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Text(
                listOfNotNull(agent.role.takeIf { it.isNotBlank() }, agent.codeAgentType).joinToString(" · ")
                    .ifBlank { agent.roleType },
                color = MutedText,
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun ConversationChildSessionRow(session: Session, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        LineIcon(kind = LineIconKind.Workflow, color = TgBlue, modifier = Modifier.size(20.dp))
        Spacer(modifier = Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(session.title.ifBlank { "任务子会话" }, color = Ink, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(formatSessionTime(session.updatedAt).ifBlank { "等待同步" }, color = MutedText, fontSize = 11.sp)
        }
        Text("›", color = MutedText, fontSize = 18.sp)
    }
}

@Composable
private fun ConversationEmptyText(text: String) {
    Text(
        text,
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
        color = MutedText,
        fontSize = 12.sp,
        lineHeight = 17.sp,
    )
}

@Composable
private fun NewGroupChatSheet(
    state: MobileUiState,
    onDismiss: () -> Unit,
    onStart: (List<String>, String?) -> Unit,
    onFallbackCreate: () -> Unit,
) {
    val workspacesById = remember(state.workspaces) { state.workspaces.associateBy { it.id } }
    val contacts = remember(state.contacts, state.agents) {
        mergeGroupChatContacts(state.contacts, state.agents)
    }
    var selectedAgentIds by remember(contacts) { mutableStateOf(setOf<String>()) }
    var title by remember { mutableStateOf("") }
    val canStart = selectedAgentIds.isNotEmpty()

    Box(modifier = Modifier.fillMaxSize()) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.54f))
                .clickable(onClick = onDismiss),
        )
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .clip(RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp))
                .background(Color(0xFF15151D))
                .imePadding()
                .navigationBarsPadding(),
        ) {
            Box(
                modifier = Modifier
                    .align(Alignment.CenterHorizontally)
                    .padding(top = 10.dp)
                    .width(38.dp)
                    .height(4.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .background(Color(0xFF3A3A45)),
            )
            Text(
                "新建对话",
                modifier = Modifier.padding(start = 18.dp, top = 16.dp),
                color = Ink,
                fontSize = 18.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                "选择一个或多个 Agent 开始对话",
                modifier = Modifier.padding(start = 18.dp, top = 4.dp, end = 18.dp),
                color = MutedText,
                fontSize = 13.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )

            if (contacts.isEmpty()) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 24.dp, vertical = 30.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    LineIcon(kind = LineIconKind.Agents, color = MutedText, modifier = Modifier.size(36.dp))
                    Text(
                        "暂无可选 Agent",
                        modifier = Modifier.padding(top = 12.dp),
                        color = Ink,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 16.sp,
                    )
                    Text(
                        "同步电脑端通讯录后，就可以从这里选择成员发起群聊。",
                        modifier = Modifier.padding(top = 6.dp),
                        color = MutedText,
                        fontSize = 13.sp,
                        lineHeight = 20.sp,
                    )
                    TextButton(onClick = onFallbackCreate, modifier = Modifier.padding(top = 10.dp)) {
                        Text("创建普通会话", color = TgBlue)
                    }
                }
            } else {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 360.dp)
                        .padding(top = 12.dp),
                ) {
                    items(contacts, key = { "${it.source}:${it.workspaceAgentId ?: it.id}" }) { agent ->
                        NewGroupAgentRow(
                            agent = agent,
                            workspace = workspacesById[agent.workspaceId],
                            selected = selectedAgentIds.contains(agent.id),
                            onClick = {
                                selectedAgentIds = if (selectedAgentIds.contains(agent.id)) {
                                    selectedAgentIds - agent.id
                                } else {
                                    selectedAgentIds + agent.id
                                }
                            },
                        )
                    }
                }
            }

            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(0.5.dp)
                    .background(Hairline),
            )
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 18.dp, vertical = 16.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(Color(0xFF22222A))
                    .padding(horizontal = 12.dp, vertical = 10.dp),
            ) {
                BasicTextField(
                    value = title,
                    onValueChange = { title = it.take(80) },
                    modifier = Modifier.fillMaxWidth(),
                    textStyle = TextStyle(color = Ink, fontSize = 15.sp),
                    singleLine = true,
                    decorationBox = { innerTextField ->
                        Box {
                            if (title.isBlank()) {
                                Text("对话标题（可选）", color = MutedText, fontSize = 15.sp)
                            }
                            innerTextField()
                        }
                    },
                )
            }
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 18.dp, end = 18.dp, bottom = 14.dp)
                    .height(52.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(if (canStart) Color(0xFF7C5CFF) else PanelElevated)
                    .clickable(enabled = canStart) {
                        onStart(
                            selectedAgentIds.toList(),
                            title.trim().takeIf { it.isNotBlank() },
                        )
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "开始对话",
                    color = if (canStart) Color.White else MutedText,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }

    }
}

@Composable
private fun NewGroupAgentRow(
    agent: AgentContact,
    workspace: Workspace?,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val avatarColor = contactAvatarColor(agent)
    val subtitle = listOfNotNull(
        workspace?.name?.takeIf { it.isNotBlank() },
        agent.role.takeIf { it.isNotBlank() },
        agent.codeAgentType?.takeIf { it.isNotBlank() } ?: agent.runtimeType.takeIf { it.isNotBlank() },
    ).joinToString(" · ").ifBlank { "通讯录 Agent" }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(42.dp)
                .clip(CircleShape)
                .background(avatarColor.copy(alpha = 0.20f))
                .border(2.dp, avatarColor, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                contactAvatarLabel(agent),
                color = Color.White,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
            )
        }
        Spacer(modifier = Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                agent.name.ifBlank { "Agent" },
                color = Ink,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                subtitle,
                modifier = Modifier.padding(top = 2.dp),
                color = MutedText,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        SelectionCircle(selected = selected)
    }
}

@Composable
private fun SelectionCircle(selected: Boolean) {
    Canvas(modifier = Modifier.size(24.dp)) {
        val strokeWidth = 2.dp.toPx()
        drawCircle(
            color = if (selected) TgBlue else Color(0xFF3A3A45),
            radius = size.minDimension / 2f - strokeWidth,
            style = Stroke(width = strokeWidth),
        )
        if (selected) {
            drawCircle(color = TgBlue, radius = size.minDimension / 2f - strokeWidth)
            drawLine(
                color = Color.White,
                start = Offset(size.width * 0.30f, size.height * 0.52f),
                end = Offset(size.width * 0.45f, size.height * 0.66f),
                strokeWidth = strokeWidth,
                cap = StrokeCap.Round,
            )
            drawLine(
                color = Color.White,
                start = Offset(size.width * 0.45f, size.height * 0.66f),
                end = Offset(size.width * 0.72f, size.height * 0.36f),
                strokeWidth = strokeWidth,
                cap = StrokeCap.Round,
            )
        }
    }
}

@Composable
private fun SettingsInfoRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = MutedText, fontSize = 13.sp, modifier = Modifier.width(64.dp))
        Text(
            value,
            color = Ink,
            fontSize = 14.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

private fun groupSessionAgents(session: Session, agents: List<WorkspaceAgent>): List<WorkspaceAgent> {
    val metadata = session.metadata
    if (metadata == null) {
        val workspaceAgentId = session.workspaceAgentId?.trim().orEmpty()
        return when {
            session.type == "group" -> agents
            workspaceAgentId.isNotBlank() -> agents.filter { agent -> agent.id == workspaceAgentId }
            else -> emptyList()
        }
    }
    val explicitAgentIds = readAgentIds(metadata["agentIds"])
    if (explicitAgentIds.isNotEmpty()) {
        val allowed = explicitAgentIds.toSet()
        return agents.filter { agent -> allowed.contains(agent.id) }
    }
    val workspaceAgentId = session.workspaceAgentId?.trim().orEmpty()
    if (workspaceAgentId.isNotBlank()) {
        return agents.filter { agent -> agent.id == workspaceAgentId }
    }
    return if (session.type == "group") agents else emptyList()
}

private fun sessionKindLabel(session: Session): String {
    val kind = session.metadata?.stringValue("kind")?.trim()?.lowercase().orEmpty()
    return when {
        kind == "orchestrator-task" -> "任务子会话"
        kind == "agent-direct" -> "Agent 私聊"
        kind == "workspace-agent-group" || session.type == "group" -> "群聊"
        session.workspaceAgentId != null -> "工作区成员会话"
        session.workspaceId != null -> "工作区会话"
        else -> "普通会话"
    }
}

private fun memberCountLabel(session: Session, agents: List<WorkspaceAgent>, childSessionCount: Int): String {
    val metadata = session.metadata
    val explicitMemberCount = metadata?.intValue("memberCount")
    val explicitAgentCount = metadata?.intValue("agentCount")
    val explicitAgentIds = readAgentIds(metadata?.get("agentIds"))
    val count = when {
        explicitMemberCount != null && explicitMemberCount > 0 -> explicitMemberCount
        explicitAgentCount != null -> explicitAgentCount + 1
        explicitAgentIds.isNotEmpty() -> explicitAgentIds.size + 1
        agents.isNotEmpty() -> agents.size + if (session.type == "group") 1 else 0
        childSessionCount > 0 -> childSessionCount + 1
        session.type == "group" -> 1
        session.workspaceAgentId != null -> 1
        else -> 0
    }
    return if (count <= 0) "0" else "${count}人"
}

private fun readAgentIds(value: kotlinx.serialization.json.JsonElement?): List<String> {
    val array = value?.asJsonArray() ?: return emptyList()
    return array.mapNotNull { element ->
        (element as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf { it.isNotBlank() }
    }
}

private fun mergeGroupChatContacts(
    contacts: List<AgentContact>,
    workspaceAgents: List<WorkspaceAgent>,
): List<AgentContact> {
    val merged = linkedMapOf<String, AgentContact>()
    (contacts + workspaceAgents.map { it.toAgentContact() }).forEach { contact ->
        val key = contact.identityKey()
        val previous = merged[key]
        if (previous == null || contact.preferForGroupChatOver(previous)) {
            merged[key] = contact
        }
    }
    return merged.values.sortedWith(
        compareBy<AgentContact> { it.name.ifBlank { "Z" }.take(1).uppercase() }
            .thenBy { it.name }
            .thenBy { it.role },
    )
}

private fun WorkspaceAgent.toAgentContact(): AgentContact {
    return AgentContact(
        id = id,
        source = "workspace-agent",
        workspaceId = workspaceId,
        workspaceAgentId = id,
        name = name,
        role = role,
        roleType = roleType,
        description = description,
        avatar = avatar,
        color = color,
        runtimeType = runtimeType,
        codeAgentType = codeAgentType,
        capabilityTags = capabilityTags,
    )
}

private fun AgentContact.preferForGroupChatOver(other: AgentContact): Boolean {
    val materialized = !workspaceId.isNullOrBlank() && !workspaceAgentId.isNullOrBlank()
    val otherMaterialized = !other.workspaceId.isNullOrBlank() && !other.workspaceAgentId.isNullOrBlank()
    if (materialized != otherMaterialized) return materialized
    return source == "workspace-agent" && other.source != "workspace-agent"
}

private fun AgentContact.identityKey(): String {
    val runtime = runtimeType.trim().lowercase()
    val codeAgent = if (runtime == "code-agent") codeAgentType?.trim()?.lowercase().orEmpty() else ""
    return listOf(
        name.trim().lowercase(),
        role.trim().lowercase(),
        runtime,
        codeAgent,
    ).joinToString("|")
}

@Composable
private fun TopBarActionButton(onClick: () -> Unit, conversationMode: Boolean) {
    Box(
        modifier = Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(PanelElevated)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (conversationMode) {
            MoreGlyph(color = Ink)
        } else {
            PlusGlyph(color = Ink, modifier = Modifier.size(18.dp))
        }

    }
}

@Composable
private fun PlusGlyph(color: Color, modifier: Modifier = Modifier.size(18.dp)) {
    Canvas(modifier = modifier) {
        val stroke = 2.6.dp.toPx()
        val centerX = size.width / 2f
        val centerY = size.height / 2f
        drawLine(
            color = color,
            start = Offset(centerX, stroke),
            end = Offset(centerX, size.height - stroke),
            strokeWidth = stroke,
            cap = StrokeCap.Round,
        )
        drawLine(
            color = color,
            start = Offset(stroke, centerY),
            end = Offset(size.width - stroke, centerY),
            strokeWidth = stroke,
            cap = StrokeCap.Round,
        )
    }
}

@Composable
private fun MoreGlyph(color: Color, modifier: Modifier = Modifier.size(18.dp)) {
    Canvas(modifier = modifier) {
        val radius = 1.9.dp.toPx()
        val centerY = size.height / 2f
        val gap = 5.5.dp.toPx()
        val centerX = size.width / 2f
        listOf(-gap, 0f, gap).forEach { dx ->
            drawCircle(color = color, radius = radius, center = Offset(centerX + dx, centerY))
        }
    }
}

@Composable
private fun LineIcon(kind: LineIconKind, color: Color, modifier: Modifier = Modifier.size(20.dp)) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height
        val sw = (w.coerceAtMost(h) * 0.085f).coerceAtLeast(1.4.dp.toPx())
        val stroke = Stroke(width = sw, cap = StrokeCap.Round)
        fun p(x: Float, y: Float) = Offset(w * x, h * y)
        fun s(x: Float, y: Float) = Size(w * x, h * y)
        when (kind) {
            LineIconKind.Search -> {
                drawCircle(color, radius = w * 0.27f, center = p(0.43f, 0.43f), style = stroke)
                drawLine(color, p(0.63f, 0.63f), p(0.84f, 0.84f), strokeWidth = sw, cap = StrokeCap.Round)
            }
            LineIconKind.Chat -> {
                drawRoundRect(color, topLeft = p(0.16f, 0.20f), size = s(0.68f, 0.48f), cornerRadius = CornerRadius(w * 0.13f), style = stroke)
                drawLine(color, p(0.38f, 0.68f), p(0.28f, 0.82f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.44f, 0.68f), p(0.28f, 0.82f), strokeWidth = sw, cap = StrokeCap.Round)
            }
            LineIconKind.Agents -> {
                drawCircle(color, radius = w * 0.13f, center = p(0.38f, 0.36f), style = stroke)
                drawCircle(color, radius = w * 0.11f, center = p(0.65f, 0.40f), style = stroke)
                drawLine(color, p(0.18f, 0.74f), p(0.58f, 0.74f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.52f, 0.72f), p(0.82f, 0.72f), strokeWidth = sw, cap = StrokeCap.Round)
            }
            LineIconKind.Bot -> {
                drawRoundRect(color, topLeft = p(0.22f, 0.28f), size = s(0.56f, 0.48f), cornerRadius = CornerRadius(w * 0.12f), style = stroke)
                drawLine(color, p(0.50f, 0.16f), p(0.50f, 0.28f), strokeWidth = sw, cap = StrokeCap.Round)
                drawCircle(color, radius = w * 0.025f, center = p(0.38f, 0.50f))
                drawCircle(color, radius = w * 0.025f, center = p(0.62f, 0.50f))
                drawLine(color, p(0.40f, 0.64f), p(0.60f, 0.64f), strokeWidth = sw, cap = StrokeCap.Round)
            }
            LineIconKind.History -> {
                drawCircle(color, radius = w * 0.32f, center = p(0.52f, 0.52f), style = stroke)
                drawLine(color, p(0.50f, 0.30f), p(0.50f, 0.54f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.50f, 0.54f), p(0.66f, 0.62f), strokeWidth = sw, cap = StrokeCap.Round)
            }
            LineIconKind.Logs -> {
                drawRoundRect(color, topLeft = p(0.22f, 0.16f), size = s(0.56f, 0.68f), cornerRadius = CornerRadius(w * 0.08f), style = stroke)
                listOf(0.35f, 0.50f, 0.65f).forEach { y ->
                    drawLine(color, p(0.34f, y), p(0.66f, y), strokeWidth = sw, cap = StrokeCap.Round)
                }
            }
            LineIconKind.Tools -> {
                drawLine(color, p(0.24f, 0.76f), p(0.74f, 0.26f), strokeWidth = sw, cap = StrokeCap.Round)
                drawCircle(color, radius = w * 0.09f, center = p(0.78f, 0.22f), style = stroke)
                drawLine(color, p(0.26f, 0.24f), p(0.76f, 0.74f), strokeWidth = sw, cap = StrokeCap.Round)
            }
            LineIconKind.Skills -> {
                drawLine(color, p(0.50f, 0.16f), p(0.62f, 0.42f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.62f, 0.42f), p(0.84f, 0.50f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.84f, 0.50f), p(0.62f, 0.58f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.62f, 0.58f), p(0.50f, 0.84f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.50f, 0.84f), p(0.38f, 0.58f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.38f, 0.58f), p(0.16f, 0.50f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.16f, 0.50f), p(0.38f, 0.42f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.38f, 0.42f), p(0.50f, 0.16f), strokeWidth = sw, cap = StrokeCap.Round)
            }
            LineIconKind.Office -> {
                drawLine(color, p(0.18f, 0.48f), p(0.50f, 0.20f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.50f, 0.20f), p(0.82f, 0.48f), strokeWidth = sw, cap = StrokeCap.Round)
                drawRoundRect(color, topLeft = p(0.28f, 0.44f), size = s(0.44f, 0.38f), cornerRadius = CornerRadius(w * 0.05f), style = stroke)
            }
            LineIconKind.Send -> {
                drawLine(color, p(0.18f, 0.50f), p(0.82f, 0.18f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.82f, 0.18f), p(0.66f, 0.82f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.18f, 0.50f), p(0.54f, 0.58f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.54f, 0.58f), p(0.66f, 0.82f), strokeWidth = sw, cap = StrokeCap.Round)
            }
            LineIconKind.File, LineIconKind.Document -> {
                drawRoundRect(color, topLeft = p(0.26f, 0.14f), size = s(0.48f, 0.72f), cornerRadius = CornerRadius(w * 0.06f), style = stroke)
                drawLine(color, p(0.58f, 0.14f), p(0.74f, 0.30f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.38f, 0.52f), p(0.62f, 0.52f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.38f, 0.64f), p(0.58f, 0.64f), strokeWidth = sw, cap = StrokeCap.Round)
            }
            LineIconKind.Image -> {
                drawRoundRect(color, topLeft = p(0.18f, 0.22f), size = s(0.64f, 0.56f), cornerRadius = CornerRadius(w * 0.08f), style = stroke)
                drawCircle(color, radius = w * 0.055f, center = p(0.36f, 0.40f), style = stroke)
                drawLine(color, p(0.28f, 0.68f), p(0.46f, 0.52f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.46f, 0.52f), p(0.60f, 0.66f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.60f, 0.66f), p(0.72f, 0.56f), strokeWidth = sw, cap = StrokeCap.Round)
            }
            LineIconKind.Web -> {
                drawCircle(color, radius = w * 0.32f, center = p(0.50f, 0.50f), style = stroke)
                drawLine(color, p(0.18f, 0.50f), p(0.82f, 0.50f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.50f, 0.18f), p(0.50f, 0.82f), strokeWidth = sw, cap = StrokeCap.Round)
            }
            LineIconKind.Presentation -> {
                drawRoundRect(color, topLeft = p(0.18f, 0.20f), size = s(0.64f, 0.44f), cornerRadius = CornerRadius(w * 0.07f), style = stroke)
                drawLine(color, p(0.50f, 0.64f), p(0.50f, 0.82f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.36f, 0.82f), p(0.64f, 0.82f), strokeWidth = sw, cap = StrokeCap.Round)
            }
            LineIconKind.Diff -> {
                drawLine(color, p(0.24f, 0.34f), p(0.46f, 0.34f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.35f, 0.23f), p(0.35f, 0.45f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.54f, 0.68f), p(0.78f, 0.68f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.22f, 0.72f), p(0.80f, 0.30f), strokeWidth = sw, cap = StrokeCap.Round)
            }
            LineIconKind.Workflow -> {
                drawCircle(color, radius = w * 0.09f, center = p(0.24f, 0.50f), style = stroke)
                drawCircle(color, radius = w * 0.09f, center = p(0.52f, 0.28f), style = stroke)
                drawCircle(color, radius = w * 0.09f, center = p(0.76f, 0.60f), style = stroke)
                drawLine(color, p(0.32f, 0.44f), p(0.44f, 0.34f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.58f, 0.36f), p(0.70f, 0.52f), strokeWidth = sw, cap = StrokeCap.Round)
            }
            LineIconKind.Info -> {
                drawCircle(color, radius = w * 0.32f, center = p(0.50f, 0.50f), style = stroke)
                drawLine(color, p(0.50f, 0.46f), p(0.50f, 0.66f), strokeWidth = sw, cap = StrokeCap.Round)
                drawCircle(color, radius = w * 0.025f, center = p(0.50f, 0.34f))
            }
            LineIconKind.Scan -> {
                drawLine(color, p(0.18f, 0.30f), p(0.18f, 0.18f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.18f, 0.18f), p(0.30f, 0.18f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.70f, 0.18f), p(0.82f, 0.18f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.82f, 0.18f), p(0.82f, 0.30f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.18f, 0.70f), p(0.18f, 0.82f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.18f, 0.82f), p(0.30f, 0.82f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.70f, 0.82f), p(0.82f, 0.82f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.82f, 0.82f), p(0.82f, 0.70f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.28f, 0.50f), p(0.72f, 0.50f), strokeWidth = sw, cap = StrokeCap.Round)
            }
            LineIconKind.Disconnect -> {
                drawLine(color, p(0.26f, 0.30f), p(0.42f, 0.46f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.58f, 0.54f), p(0.74f, 0.70f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.44f, 0.28f), p(0.34f, 0.18f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.56f, 0.40f), p(0.46f, 0.30f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.64f, 0.72f), p(0.74f, 0.82f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.52f, 0.60f), p(0.62f, 0.70f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.24f, 0.74f), p(0.76f, 0.24f), strokeWidth = sw, cap = StrokeCap.Round)
            }
            LineIconKind.Archive -> {
                drawRoundRect(color, topLeft = p(0.18f, 0.24f), size = s(0.64f, 0.58f), cornerRadius = CornerRadius(w * 0.08f), style = stroke)
                drawLine(color, p(0.24f, 0.38f), p(0.76f, 0.38f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.38f, 0.55f), p(0.62f, 0.55f), strokeWidth = sw, cap = StrokeCap.Round)
            }
            LineIconKind.Delete -> {
                drawLine(color, p(0.28f, 0.30f), p(0.72f, 0.30f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.42f, 0.20f), p(0.58f, 0.20f), strokeWidth = sw, cap = StrokeCap.Round)
                drawRoundRect(color, topLeft = p(0.32f, 0.34f), size = s(0.36f, 0.48f), cornerRadius = CornerRadius(w * 0.05f), style = stroke)
                drawLine(color, p(0.43f, 0.45f), p(0.43f, 0.70f), strokeWidth = sw * 0.8f, cap = StrokeCap.Round)
                drawLine(color, p(0.57f, 0.45f), p(0.57f, 0.70f), strokeWidth = sw * 0.8f, cap = StrokeCap.Round)
            }
            LineIconKind.Refresh -> {
                drawArc(color, startAngle = 35f, sweepAngle = 265f, useCenter = false, topLeft = p(0.22f, 0.22f), size = s(0.56f, 0.56f), style = stroke)
                drawLine(color, p(0.72f, 0.22f), p(0.79f, 0.38f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.72f, 0.22f), p(0.56f, 0.25f), strokeWidth = sw, cap = StrokeCap.Round)
            }
            LineIconKind.Pin -> {
                drawLine(color, p(0.42f, 0.20f), p(0.70f, 0.48f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.30f, 0.48f), p(0.58f, 0.76f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.36f, 0.42f), p(0.58f, 0.20f), strokeWidth = sw, cap = StrokeCap.Round)
                drawLine(color, p(0.30f, 0.78f), p(0.44f, 0.64f), strokeWidth = sw, cap = StrokeCap.Round)
            }
        }
    }
}

@Composable
private fun MessageArea(
    state: MobileUiState,
    showSessions: Boolean,
    onShowSessions: () -> Unit,
    onOpenConversation: (Session) -> Unit,
    onRefresh: () -> Unit,
    onCreateSession: () -> Unit,
    onSendMessage: (String) -> Unit,
    onArchiveSession: (String) -> Unit,
    onUnarchiveSession: (String) -> Unit,
    onDeleteSession: (String) -> Unit,
) {
    AnimatedContent(
        targetState = showSessions,
        transitionSpec = {
            if (targetState) {
                (slideInHorizontally { -it / 2 } + fadeIn()).togetherWith(slideOutHorizontally { it / 2 } + fadeOut())
            } else {
                (slideInHorizontally { it / 2 } + fadeIn()).togetherWith(slideOutHorizontally { -it / 2 } + fadeOut())
            }.using(SizeTransform(clip = false))
        },
        label = "message-area-transition",
    ) { sessionsVisible ->
        if (sessionsVisible) {
            SessionListScreen(
                sessions = state.sessions,
                selectedSessionId = state.selectedSessionId,
                archivedSessionIds = state.archivedSessionIds,
                onRefresh = onRefresh,
                onCreateSession = onCreateSession,
                onSelect = onOpenConversation,
                onArchiveSession = onArchiveSession,
                onUnarchiveSession = onUnarchiveSession,
                onDeleteSession = onDeleteSession,
            )
        } else {
            ConversationScreen(
                state = state,
                onOpenSessions = onShowSessions,
                onSendMessage = onSendMessage,
            )
        }
    }
}

@Composable
private fun SessionListScreen(
    sessions: List<Session>,
    selectedSessionId: String?,
    archivedSessionIds: Set<String>,
    onRefresh: () -> Unit,
    onCreateSession: () -> Unit,
    onSelect: (Session) -> Unit,
    onArchiveSession: (String) -> Unit,
    onUnarchiveSession: (String) -> Unit,
    onDeleteSession: (String) -> Unit,
) {
    var showArchived by remember { mutableStateOf(false) }
    val visibleSessions = sessions.filter { archivedSessionIds.contains(it.id) == showArchived }

    Column(modifier = Modifier.fillMaxSize().background(PageBackground)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .height(42.dp)
                    .clip(RoundedCornerShape(24.dp))
                    .background(SoftFill)
                    .padding(horizontal = 15.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    LineIcon(kind = LineIconKind.Search, color = MutedText, modifier = Modifier.size(17.dp))
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("搜索对话", color = MutedText, fontSize = 15.sp)
                }
            }
            Spacer(modifier = Modifier.width(8.dp))
            Box(
                modifier = Modifier
                    .height(42.dp)
                    .clip(RoundedCornerShape(24.dp))
                    .background(if (showArchived) TgBlueLight else PanelElevated)
                    .clickable { showArchived = !showArchived }
                    .padding(horizontal = 14.dp, vertical = 10.dp),
            ) {
                Text(
                    text = if (showArchived) "归档" else "全部",
                    color = if (showArchived) TgBlue else MutedText,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                )
            }
        }

        Box(modifier = Modifier.weight(1f)) {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(bottom = 110.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                item { Spacer(modifier = Modifier.height(2.dp)) }
                items(visibleSessions, key = { it.id }) { session ->
                    SessionRow(
                        session = session,
                        selected = session.id == selectedSessionId,
                        archived = archivedSessionIds.contains(session.id),
                        onClick = { onSelect(session) },
                        onArchive = { onArchiveSession(session.id) },
                        onUnarchive = { onUnarchiveSession(session.id) },
                        onDelete = { onDeleteSession(session.id) },
                    )
                }
                if (visibleSessions.isEmpty()) {
                    item {
                        EmptySessionList(
                            archived = showArchived,
                            onCreateSession = onCreateSession,
                            onRefresh = onRefresh,
                        )
                    }
                }
                item { Spacer(modifier = Modifier.height(24.dp)) }
            }
        }
    }
}

@Composable
private fun EmptySessionList(archived: Boolean, onCreateSession: () -> Unit, onRefresh: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 40.dp, vertical = 60.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            modifier = Modifier
                .size(72.dp)
                .clip(CircleShape)
                .background(TgBlueLight),
            contentAlignment = Alignment.Center,
        ) {
            LineIcon(kind = LineIconKind.Chat, color = TgBlue, modifier = Modifier.size(34.dp))
        }
        Text(
            if (archived) "暂无归档会话" else "还没有消息",
            modifier = Modifier.padding(top = 16.dp),
            color = Ink,
            fontWeight = FontWeight.SemiBold,
            fontSize = 18.sp,
        )
        Text(
            if (archived) "删除前可以先把不常用会话收进这里。" else "同步电脑端或创建新会话开始聊天",
            modifier = Modifier.padding(top = 8.dp),
            color = MutedText,
            fontSize = 14.sp,
            lineHeight = 20.sp,
        )
        Row(modifier = Modifier.padding(top = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(
                onClick = onCreateSession,
                colors = ButtonDefaults.buttonColors(containerColor = TgBlue),
                shape = RoundedCornerShape(20.dp),
            ) {
                Text("新建会话")
            }
            OutlinedButton(
                onClick = onRefresh,
                shape = RoundedCornerShape(20.dp),
            ) {
                Text("同步")
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionRow(
    session: Session,
    selected: Boolean,
    archived: Boolean,
    onClick: () -> Unit,
    onArchive: () -> Unit,
    onUnarchive: () -> Unit,
    onDelete: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    val lastMessage = remember(session) { sessionPreviewText(session) }
    val sessionTime = remember(session) { formatSessionTime(session.updatedAt) }
    val unreadCount = 0

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(if (selected) SessionCardSurface else Color.Transparent)
            .combinedClickable(
                onClick = onClick,
                onLongClick = { menuOpen = true },
            )
            .padding(horizontal = 12.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SessionAvatar(session)
        Spacer(modifier = Modifier.width(14.dp))
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (session.type == "group") {
                    LineIcon(kind = LineIconKind.Agents, color = MutedText, modifier = Modifier.size(14.dp))
                    Spacer(modifier = Modifier.width(3.dp))
                }
                Text(
                    text = session.title.ifBlank { "未命名会话" },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    fontWeight = FontWeight.SemiBold,
                    color = Ink,
                    fontSize = 16.sp,
                    modifier = Modifier.weight(1f),
                )
                Text(sessionTime, color = if (unreadCount > 0) TgBlue else MutedText, fontSize = 12.sp)
            }
            Row(
                modifier = Modifier.padding(top = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = lastMessage,
                    modifier = Modifier.weight(1f),
                    color = MutedText,
                    fontSize = 14.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (unreadCount > 0) {
                    Spacer(modifier = Modifier.width(8.dp))
                    Box(
                        modifier = Modifier
                            .size(20.dp)
                            .clip(CircleShape)
                            .background(TgUnreadBg),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = if (unreadCount > 99) "99+" else unreadCount.toString(),
                            color = Color.White,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
            }
        }
        Spacer(modifier = Modifier.width(8.dp))
        Box(
            modifier = Modifier
                .size(32.dp)
                .clip(CircleShape)
                .clickable { menuOpen = true },
            contentAlignment = Alignment.Center,
        ) {
            MoreGlyph(color = MutedText, modifier = Modifier.size(16.dp))
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(text = { Text(if (archived) "移出归档" else "归档") }, onClick = {
                    menuOpen = false
                    if (archived) onUnarchive() else onArchive()
                })
                DropdownMenuItem(text = { Text("删除") }, onClick = {
                    menuOpen = false
                    confirmDelete = true
                })
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("删除会话") },
            text = { Text("会话和消息会从电脑端删除，此操作不可撤销。") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    onDelete()
                }) {
                    Text("删除", color = Color(0xFFB42318))
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) {
                    Text("取消")
                }
            },
        )
    }
}

@Composable
private fun MainTabBar(modifier: Modifier = Modifier, active: MobileTab, onSelect: (MobileTab) -> Unit) {
    Box(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .fillMaxWidth(0.88f)
                .padding(vertical = 7.dp)
                .clip(RoundedCornerShape(24.dp))
                .background(BottomGlass)
                .border(0.5.dp, Hairline, RoundedCornerShape(24.dp))
                .padding(horizontal = 5.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceAround,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            MobileTab.values().forEach { tab ->
                TabItem(
                    modifier = Modifier.weight(1f),
                    tab = tab,
                    active = active == tab,
                    onClick = { onSelect(tab) },
                )
            }
        }

    }
}

@Composable
private fun TabItem(modifier: Modifier = Modifier, tab: MobileTab, active: Boolean, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .then(modifier)
            .clip(RoundedCornerShape(15.dp))
            .background(if (active) TgBlueLight else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 5.dp, vertical = 5.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        TabIcon(tab = tab, active = active)
        Text(
            text = tab.label,
            modifier = Modifier.padding(top = 2.dp),
            color = if (active) TgBlue else MutedText,
            fontSize = 10.sp,
            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        )
    }
}

@Composable
private fun TabIcon(tab: MobileTab, active: Boolean) {
    val tint = if (active) TgBlue else MutedText
    Image(
        painter = painterResource(tab.iconRes),
        contentDescription = tab.label,
        modifier = Modifier.size(21.dp),
        colorFilter = ColorFilter.tint(tint),
    )
}

@Composable
private fun ConversationScreen(
    state: MobileUiState,
    onOpenSessions: () -> Unit,
    onSendMessage: (String) -> Unit,
) {
    var input by remember(state.selectedSessionId) { mutableStateOf("") }
    var previewArtifact by remember { mutableStateOf<MobileArtifact?>(null) }
    var composerFocused by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val density = LocalDensity.current
    val imeVisible = WindowInsets.ime.getBottom(density) > 0
    val messages = state.messages + listOfNotNull(state.streamingMessage)
    val showHome = messages.isEmpty() && !state.agentTyping
    val bottomItemIndex = 1 + messages.size + if (state.agentTyping && state.streamingMessage == null) 1 else 0
    val streamingLength = state.streamingMessage?.content?.length ?: 0

    LaunchedEffect(state.selectedSessionId, messages.size, streamingLength, state.agentTyping) {
        if (!showHome && bottomItemIndex >= 1) {
            delay(60)
            listState.scrollToItem(bottomItemIndex)
        }
    }

    LaunchedEffect(composerFocused, imeVisible, bottomItemIndex) {
        if (composerFocused && !showHome && bottomItemIndex >= 1) {
            delay(if (imeVisible) 260 else 120)
            listState.animateScrollToItem(bottomItemIndex)
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(TgChatBg)) {
        TelegramChatPattern(modifier = Modifier.matchParentSize())
        if (state.selectedSession == null && state.sessions.isNotEmpty()) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                OutlinedButton(onClick = onOpenSessions) {
                    Text("选择会话")
                }
            }
        } else if (showHome) {
            MobileHomeContent(
                modifier = Modifier
                    .fillMaxSize()
                    .imePadding()
                    .padding(horizontal = 30.dp),
            )
        } else {
            val streamingId = state.streamingMessage?.id
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .fillMaxSize()
                    .imePadding()
                    .padding(bottom = 104.dp),
                verticalArrangement = Arrangement.spacedBy(1.dp),
            ) {
                item { Spacer(modifier = Modifier.height(4.dp)) }
                items(messages, key = { it.id }) { message ->
                    MessageBubble(
                        message = message,
                        streaming = message.id == streamingId,
                        streamingCodeAgentRun = if (message.id == streamingId) state.streamingCodeAgentRun else null,
                        baseUrl = state.connection?.baseUrl,
                        workspaceId = state.selectedSession?.workspaceId,
                        currentUser = state.currentUser,
                        onPreviewArtifact = { previewArtifact = it },
                    )
                }
                if (state.agentTyping && state.streamingMessage == null) {
                    item {
                        TypingIndicator()
                    }
                }
                item { Spacer(modifier = Modifier.height(10.dp)) }
            }
        }

        if (state.selectedSession != null) {
            MobileChatComposer(
                value = input,
                onValueChange = { input = it },
                onFocusChanged = { composerFocused = it },
                onSend = {
                    val content = input.trim()
                    if (content.isNotBlank()) {
                        onSendMessage(content)
                        input = ""
                    }
                },
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .imePadding(),
            )
        }

        previewArtifact?.let { artifact ->
            ArtifactPreviewOverlay(
                artifact = artifact,
                baseUrl = state.connection?.baseUrl,
                authToken = state.connection?.authToken,
                onClose = { previewArtifact = null },
            )
        }
    }
}

@Composable
private fun MobileHomeContent(modifier: Modifier) {
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(modifier = Modifier.weight(1f))
        Box(
            modifier = Modifier
                .size(72.dp)
                .clip(CircleShape)
                .background(TgBlueLight),
            contentAlignment = Alignment.Center,
        ) {
            LineIcon(kind = LineIconKind.Bot, color = TgBlue, modifier = Modifier.size(34.dp))
        }
        Text(
            text = "AgentHub",
            modifier = Modifier.padding(top = 12.dp),
            color = Ink,
            fontSize = 22.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text = "有什么可以帮忙的？",
            modifier = Modifier.padding(top = 6.dp),
            color = MutedText,
            fontSize = 15.sp,
        )
        Spacer(modifier = Modifier.weight(1.6f))
    }
}

@Composable
private fun TelegramChatPattern(modifier: Modifier = Modifier) {
    Canvas(modifier = modifier) {
        val line = Hairline.copy(alpha = 0.22f)
        val blue = TgBlue.copy(alpha = 0.08f)
        val stepX = 92.dp.toPx()
        val stepY = 88.dp.toPx()
        var y = 24.dp.toPx()
        var row = 0
        while (y < size.height) {
            var x = if (row % 2 == 0) 22.dp.toPx() else 62.dp.toPx()
            while (x < size.width) {
                drawCircle(color = blue, radius = 12.dp.toPx(), center = Offset(x, y))
                drawLine(
                    color = line,
                    start = Offset(x - 18.dp.toPx(), y + 18.dp.toPx()),
                    end = Offset(x + 18.dp.toPx(), y + 4.dp.toPx()),
                    strokeWidth = 1.dp.toPx(),
                    cap = StrokeCap.Round,
                )
                drawCircle(color = line, radius = 3.dp.toPx(), center = Offset(x + 24.dp.toPx(), y - 16.dp.toPx()))
                x += stepX
            }
            y += stepY
            row += 1
        }
    }
}

@Composable
private fun AgentDirectoryScreen(
    state: MobileUiState,
    onOpenAgentContact: (AgentContact) -> Unit,
    onRefresh: () -> Unit,
) {
    val workspacesById = remember(state.workspaces) { state.workspaces.associateBy { it.id } }
    val contacts = remember(state.contacts, state.workspaces) {
        state.contacts.sortedWith(
            compareBy<AgentContact> {
                it.name.ifBlank { "Z" }.take(1).uppercase()
            }.thenBy { it.name }.thenBy { it.role },
        )
    }
    // Group contacts by first letter (Telegram-style)
    val groupedContacts = remember(contacts) {
        contacts.groupBy { contact ->
            val name = contact.name.ifBlank { "Agent" }
            val first = name.take(1).uppercase()
            if (first.matches(Regex("[A-Z]"))) first else "#"
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(PageBackground)) {
        // Search bar
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .height(38.dp)
                    .clip(RoundedCornerShape(20.dp))
                    .background(SoftFill)
                    .padding(horizontal = 14.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text("搜索 Agent", color = MutedText, fontSize = 15.sp)
            }
        }

        if (contacts.isEmpty()) {
            EmptyAgentDirectory(onRefresh = onRefresh)
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
            ) {
                // Header: synced count
                item {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "${contacts.size} 个 Agent",
                            color = MutedText,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                        )
                        Spacer(modifier = Modifier.weight(1f))
                        Text(
                            "同步",
                            modifier = Modifier
                                .clip(RoundedCornerShape(16.dp))
                                .clickable(onClick = onRefresh)
                                .padding(horizontal = 10.dp, vertical = 4.dp),
                            color = TgBlue,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                        )
                    }
                }

                // Grouped contacts with letter headers
                groupedContacts.forEach { (letter, groupContacts) ->
                    // Letter header
                    item(key = "header_$letter") {
                        Text(
                            text = letter,
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(SoftFill)
                                .padding(horizontal = 16.dp, vertical = 6.dp),
                            color = MutedText,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    // Contact rows
                    items(groupContacts, key = { it.uniqueKey() }) { contact ->
                        AgentContactRow(
                            contact = contact,
                            workspace = workspacesById[contact.workspaceId],
                            hasSession = state.sessions.any { session ->
                                sessionMatchesContact(session, contact)
                            },
                            onClick = { onOpenAgentContact(contact) },
                        )
                    }
                }

                item { Spacer(modifier = Modifier.height(84.dp)) }
            }
        }
    }
}

@Composable
private fun EmptyAgentDirectory(onRefresh: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 40.dp, vertical = 60.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            modifier = Modifier
                .size(72.dp)
                .clip(CircleShape)
                .background(TgBlueLight),
            contentAlignment = Alignment.Center,
        ) {
            LineIcon(kind = LineIconKind.Agents, color = TgBlue, modifier = Modifier.size(34.dp))
        }
        Text(
            "暂无联系人",
            modifier = Modifier.padding(top = 16.dp),
            color = Ink,
            fontWeight = FontWeight.SemiBold,
            fontSize = 18.sp,
        )
        Text(
            "连接电脑端后会自动同步 Agent 通讯录",
            modifier = Modifier.padding(top = 8.dp),
            color = MutedText,
            fontSize = 14.sp,
            lineHeight = 20.sp,
        )
        Button(
            onClick = onRefresh,
            modifier = Modifier.padding(top = 20.dp),
            colors = ButtonDefaults.buttonColors(containerColor = TgBlue),
            shape = RoundedCornerShape(20.dp),
        ) {
            Text("同步通讯录")
        }
    }
}

@Composable
private fun AgentContactRow(
    contact: AgentContact,
    workspace: Workspace?,
    hasSession: Boolean,
    onClick: () -> Unit,
) {
    val avatarColor = contactAvatarColor(contact)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(PanelBackground)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Circular avatar (Telegram style)
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(CircleShape)
                .background(avatarColor.copy(alpha = 0.20f))
                .border(2.dp, avatarColor, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                contactAvatarLabel(contact),
                color = Color.White,
                fontWeight = FontWeight.Bold,
                fontSize = 18.sp,
            )
        }
        Spacer(modifier = Modifier.width(14.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                contact.name.ifBlank { "Agent" },
                color = Ink,
                fontWeight = FontWeight.Medium,
                fontSize = 16.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                listOfNotNull(
                    workspace?.name?.takeIf { it.isNotBlank() },
                    contact.role.takeIf { it.isNotBlank() } ?: contact.roleType,
                ).joinToString(" · "),
                modifier = Modifier.padding(top = 3.dp),
                color = MutedText,
                fontSize = 14.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        // Online indicator or status
        if (hasSession) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(TgOnlineGreen),
            )
        }
    }
}

@Composable
private fun WorkbenchScreenV2(
    state: MobileUiState,
    onRefresh: () -> Unit,
    onCreateSession: () -> Unit,
    onOpenWorkspaceGroupSession: (String) -> Unit,
) {
    val workbench = state.workbench
    val taskItems = workbench?.tasks.orEmpty()
    val runItems = workbench?.runs.orEmpty()
    val attentionTasks = taskItems
        .filter { taskRequiresAttention(it) }
        .sortedByDescending { taskSortKey(it) }
    val activeTasks = taskItems.filter { it.status in setOf("pending", "running", "blocked") }
    val conflictRuns = runItems.filter { it.conflictCount > 0 }
    val groupProgress = buildGroupProgressSnapshots(state, taskItems, runItems)
    val activeGroupCount = groupProgress.count { it.status in setOf("planning", "pending", "running", "synthesizing", "blocked") }
    var expandedGroupIds by remember(groupProgress) { mutableStateOf(groupProgress.take(3).map { it.id }.toSet()) }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            FeatureHero(
                title = "会话审批与进度",
                subtitle = if (state.connected) {
                    "集中查看需要你处理的会话事项，并按群聊汇总主进度与子 Agent 进度。"
                } else {
                    "连接电脑端后，这里会同步会话审批、冲突复核和群聊任务进度。"
                },
                icon = LineIconKind.Workflow,
                action = if (state.workbenchLoading) "同步中" else "刷新",
                onAction = onRefresh,
            )
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                MetricCard("待处理", (attentionTasks.size + conflictRuns.size).toString(), Modifier.weight(1f))
                MetricCard("运行任务", activeTasks.count { it.status == "running" }.toString(), Modifier.weight(1f))
                MetricCard("活跃群聊", activeGroupCount.toString(), Modifier.weight(1f))
            }
        }
        item { WorkbenchSectionHeader("会话审批中心", "需要确认、复核或排障的会话事项") }
        if (attentionTasks.isEmpty() && conflictRuns.isEmpty()) {
            item { WorkbenchEmptyCard("暂无待处理事项", "当前没有阻塞任务、失败任务或需要人工复核的会话冲突。") }
        } else {
            items(conflictRuns.take(3), key = { "conflict-${it.id}" }) { run ->
                RunConflictCard(
                    run = run,
                    onOpenGroup = { onOpenWorkspaceGroupSession(run.workspaceId) },
                )
            }
            items(attentionTasks.take(6), key = { it.id }) { task ->
                TaskAttentionCard(
                    task = task,
                    onOpenGroup = { onOpenWorkspaceGroupSession(task.workspaceId) },
                )
            }
        }
        item { WorkbenchSectionHeader("群聊主进度", "以群聊为主线汇总进度，展开查看子 Agent 执行状态") }
        if (groupProgress.isEmpty()) {
            item { WorkbenchEmptyCard("暂无群聊进度", "触发一次群聊协作后，这里会按群聊展示主进度和子 Agent 进度。") }
        } else {
            items(groupProgress.take(16), key = { it.id }) { item ->
                GroupProgressCard(
                    item = item,
                    expanded = expandedGroupIds.contains(item.id),
                    onToggleExpanded = {
                        expandedGroupIds = if (expandedGroupIds.contains(item.id)) {
                            expandedGroupIds - item.id
                        } else {
                            expandedGroupIds + item.id
                        }
                    },
                    onOpenGroup = {
                        val workspaceId = item.workspaceId
                        if (workspaceId != null) onOpenWorkspaceGroupSession(workspaceId)
                    },
                )
            }
        }
        item { WorkbenchSectionHeader("最近会话流转", "Orchestrator 运行状态与任务调度历史") }
        if (runItems.isEmpty()) {
            item { WorkbenchEmptyCard("暂无运行记录", "从群聊触发 Orchestrator 后，这里会展示最近运行。") }
        } else {
            items(runItems.take(4), key = { "run-${it.id}" }) { run ->
                RunSummaryCard(run = run, onOpenGroup = { onOpenWorkspaceGroupSession(run.workspaceId) })
            }
        }
        item {
            QuickEntry("新会话", "从手机端发起一个新的电脑端会话", "+", onCreateSession)
            Spacer(modifier = Modifier.height(84.dp))
        }
    }
}

@Composable
private fun WorkbenchSectionHeader(title: String, subtitle: String, onClick: (() -> Unit)? = null) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 4.dp),
    ) {
        Text(title, color = Ink, fontSize = 16.sp, fontWeight = FontWeight.Bold, maxLines = 1)
        Text(
            subtitle,
            modifier = Modifier.padding(top = 2.dp),
            color = MutedText,
            fontSize = 12.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

private data class GroupProgressSnapshot(
    val id: String,
    val workspaceId: String?,
    val workspace: Workspace?,
    val run: MobileWorkbenchRunSummary?,
    val title: String,
    val status: String,
    val progressPercent: Int,
    val attentionCount: Int,
    val activeCount: Int,
    val completedCount: Int,
    val updatedAt: String,
    val childProgress: List<ChildAgentProgressSnapshot>,
)

private data class ChildAgentProgressSnapshot(
    val agent: WorkspaceAgent?,
    val workspace: Workspace?,
    val task: MobileWorkbenchTaskSummary?,
    val fallbackAgentId: String,
    val fallbackName: String,
    val fallbackRole: String,
)

@Composable
private fun RunConflictCard(run: MobileWorkbenchRunSummary, onOpenGroup: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(PanelBackground)
            .clickable(onClick = onOpenGroup)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(Color(0xFF3A2B1D)),
                contentAlignment = Alignment.Center,
            ) {
                LineIcon(kind = LineIconKind.Diff, color = WorkAmber, modifier = Modifier.size(20.dp))
            }
            Spacer(modifier = Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text("会话冲突待复核", color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Text(
                    run.sessionTitle.ifBlank { run.workspaceName.ifBlank { "群聊运行" } },
                    modifier = Modifier.padding(top = 2.dp),
                    color = MutedText,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            WorkbenchChip("${run.conflictCount} 项")
        }
        Text(
            "${formatWorkbenchDate(run.updatedAt)} · ${workbenchStatusLabel(run.status)}",
            color = MutedText,
            fontSize = 11.sp,
        )
    }
}

@Composable
private fun TaskAttentionCard(task: MobileWorkbenchTaskSummary, onOpenGroup: () -> Unit) {
    val color = workbenchStatusColor(task.status)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(PanelBackground)
            .clickable(onClick = onOpenGroup)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(color.copy(alpha = 0.16f)),
                contentAlignment = Alignment.Center,
            ) {
                LineIcon(kind = LineIconKind.Workflow, color = color, modifier = Modifier.size(20.dp))
            }
            Spacer(modifier = Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    task.title.ifBlank { "未命名任务" },
                    color = Ink,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 14.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    listOfNotNull(
                        task.workspaceName.takeIf { it.isNotBlank() },
                        task.agentName.takeIf { it.isNotBlank() },
                    ).joinToString(" · ").ifBlank { task.sessionTitle.ifBlank { "会话任务" } },
                    modifier = Modifier.padding(top = 2.dp),
                    color = MutedText,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            WorkbenchChip(workbenchStatusLabel(task.status))
        }
        WorkbenchProgressBar(progress = taskProgressPercent(task), color = color)
        Text(
            task.progressStatus.ifBlank { task.errorLog?.lineSequence()?.firstOrNull().orEmpty() }.ifBlank { "等待你打开会话查看详情" },
            color = MutedText,
            fontSize = 12.sp,
            lineHeight = 17.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun GroupProgressCard(
    item: GroupProgressSnapshot,
    expanded: Boolean,
    onToggleExpanded: () -> Unit,
    onOpenGroup: () -> Unit,
) {
    val color = workbenchStatusColor(item.status)
    val subtitle = listOfNotNull(
        item.workspace?.name?.takeIf { it.isNotBlank() },
        item.run?.updatedAt?.takeIf { it.isNotBlank() }?.let { formatWorkbenchDate(it) },
    ).joinToString(" · ").ifBlank { "群聊协作进度" }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(PanelBackground)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(42.dp)
                    .clip(RoundedCornerShape(13.dp))
                    .background(color.copy(alpha = 0.16f)),
                contentAlignment = Alignment.Center,
            ) {
                LineIcon(kind = LineIconKind.Workflow, color = color, modifier = Modifier.size(22.dp))
            }
            Spacer(modifier = Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    item.title.ifBlank { "群聊进度" },
                    color = Ink,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 15.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    subtitle,
                    modifier = Modifier.padding(top = 2.dp),
                    color = MutedText,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            WorkbenchChip(workbenchStatusLabel(item.status))
        }
        WorkbenchProgressBar(progress = item.progressPercent, color = color)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            WorkbenchChip("执行 ${item.activeCount}")
            WorkbenchChip("完成 ${item.completedCount}")
            if (item.attentionCount > 0) WorkbenchChip("待处理 ${item.attentionCount}")
        }
        AnimatedVisibility(visible = expanded) {
            Column(verticalArrangement = Arrangement.spacedBy(0.dp)) {
                if (item.childProgress.isEmpty()) {
                    Text(
                        "暂无子 Agent 进度，等待 Orchestrator 分发任务。",
                        color = MutedText,
                        fontSize = 12.sp,
                        lineHeight = 17.sp,
                    )
                } else {
                    item.childProgress.forEachIndexed { index, child ->
                        if (index > 0) {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(start = 46.dp, top = 2.dp, bottom = 2.dp)
                                    .height(0.5.dp)
                                    .background(Hairline),
                            )
                        }
                        ChildAgentProgressRow(child = child)
                    }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = onToggleExpanded) {
                Text(if (expanded) "收起子进度" else "展开子进度", color = TgBlue, fontSize = 12.sp)
            }
            TextButton(onClick = onOpenGroup) {
                Text("打开群聊", color = TgBlue, fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun ChildAgentProgressRow(child: ChildAgentProgressSnapshot) {
    val task = child.task
    val status = task?.status ?: "idle"
    val color = workbenchStatusColor(status)
    val avatarColor = child.agent?.let { workspaceAgentAvatarColor(it) }
        ?: fallbackAgentAvatarColor("${child.fallbackAgentId}:${child.fallbackName}")
    val avatarLabel = child.agent?.let { workspaceAgentAvatarLabel(it) }
        ?: child.fallbackName.ifBlank { "A" }.take(1).uppercase()
    val name = child.agent?.name?.takeIf { it.isNotBlank() } ?: child.fallbackName.ifBlank { "Agent" }
    val role = child.agent?.role?.takeIf { it.isNotBlank() }
        ?: child.fallbackRole.takeIf { it.isNotBlank() }
        ?: child.agent?.roleType
        ?: "子任务"
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 7.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(34.dp)
                    .clip(CircleShape)
                    .background(avatarColor.copy(alpha = 0.22f))
                    .border(1.dp, avatarColor, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(avatarLabel, color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(modifier = Modifier.width(10.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    name,
                    color = Ink,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    listOfNotNull(
                        role,
                        task?.title?.takeIf { it.isNotBlank() },
                    ).joinToString(" · ").ifBlank { "等待任务分配" },
                    modifier = Modifier.padding(top = 2.dp),
                    color = MutedText,
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            WorkbenchChip(workbenchStatusLabel(status))
        }
        WorkbenchProgressBar(progress = task?.let { taskProgressPercent(it) } ?: 0, color = color)
        Text(
            task?.progressStatus?.ifBlank { task.description }?.ifBlank { "等待 Orchestrator 调度" }
                ?: "等待 Orchestrator 调度",
            modifier = Modifier.padding(start = 44.dp),
            color = MutedText,
            fontSize = 11.sp,
            lineHeight = 16.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun WorkbenchProgressBar(progress: Int, color: Color) {
    val fraction = (progress.coerceIn(0, 100) / 100f).coerceAtLeast(if (progress > 0) 0.04f else 0f)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(5.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(PanelElevated),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth(fraction)
                .height(5.dp)
                .clip(RoundedCornerShape(999.dp))
                .background(color),
        )
    }
}

@Composable
private fun WorkbenchEmptyCard(title: String, subtitle: String) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(PanelBackground)
            .padding(16.dp),
    ) {
        Text(title, color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
        Text(
            subtitle,
            modifier = Modifier.padding(top = 6.dp),
            color = MutedText,
            fontSize = 12.sp,
            lineHeight = 18.sp,
        )
    }
}

@Composable
private fun WorkspaceSummaryCard(
    workspace: MobileWorkbenchWorkspaceSummary,
    onOpenGroup: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(PanelBackground)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                    modifier = Modifier
                        .size(42.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(TgBlue),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    workspace.name.ifBlank { "W" }.take(1).uppercase(),
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp,
                )
            }
            Spacer(modifier = Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    workspace.name.ifBlank { "未命名工作区" },
                    color = Ink,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 15.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    workspace.goal.ifBlank { workspace.projectPath.orEmpty().ifBlank { "暂无目标" } },
                    modifier = Modifier.padding(top = 3.dp),
                    color = MutedText,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            TextButton(onClick = onOpenGroup) {
                Text("群聊", color = TgBlue)
            }
        }
        Text(
            workspace.projectPath.orEmpty().ifBlank { "未绑定项目路径" },
            color = MutedText,
            fontSize = 11.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            WorkbenchChip("Agent ${workspace.agentCount}")
            WorkbenchChip("任务 ${workspace.taskCount}")
            WorkbenchChip("会话 ${workspace.sessionCount}")
        }
    }
}

@Composable
private fun RunSummaryCard(run: MobileWorkbenchRunSummary, onOpenGroup: (() -> Unit)? = null) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(PanelBackground)
            .then(if (onOpenGroup != null) Modifier.clickable(onClick = onOpenGroup) else Modifier)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    run.workspaceName.ifBlank { "工作区" },
                    color = Ink,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 14.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    run.sessionTitle.ifBlank { run.groupSessionId },
                    modifier = Modifier.padding(top = 3.dp),
                    color = MutedText,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (run.conflictCount > 0) {
                WorkbenchChip("冲突 ${run.conflictCount}")
                Spacer(modifier = Modifier.width(6.dp))
            }
            WorkbenchChip(workbenchStatusLabel(run.status))
        }
        Text(
            "${formatWorkbenchDate(run.createdAt)} · ${run.id.take(8)}",
            color = MutedText,
            fontSize = 11.sp,
            maxLines = 1,
        )
    }
}

@Composable
private fun CodingToolsCard(
    items: List<MobileWorkbenchCodingToolItem>,
    loading: Boolean,
    onInstall: () -> Unit,
    onRepair: () -> Unit,
    onClick: (() -> Unit)? = null,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(PanelBackground)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    if (loading) "同步中..." else "CLI 状态",
                    color = Ink,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 14.sp,
                )
                Text(
                    "支持 Codex、Claude Code、OpenCode、Gemini",
                    modifier = Modifier.padding(top = 3.dp),
                    color = MutedText,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            WorkbenchChip("${items.count { it.ready }} ready")
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onInstall, modifier = Modifier.weight(1f)) {
                Text("安装缺失")
            }
            Button(
                onClick = onRepair,
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = TgBlue),
            ) {
                Text("修复")
            }
        }
        if (items.isEmpty()) {
            Text("暂无 CLI 探测结果。", color = MutedText, fontSize = 12.sp)
        } else {
            items.take(4).forEach { tool ->
                CodingToolRow(tool = tool)
            }
        }
    }
}

@Composable
private fun CodingToolRow(tool: MobileWorkbenchCodingToolItem) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(PanelElevated)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    tool.name,
                    color = Ink,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    tool.configMessage,
                    modifier = Modifier.padding(top = 2.dp),
                    color = MutedText,
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            WorkbenchChip(if (tool.ready) "ready" else "not ready")
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            WorkbenchChip(tool.command)
            if (!tool.version.isNullOrBlank()) WorkbenchChip(tool.version!!)
            if (!tool.configEnv.isNullOrBlank()) WorkbenchChip(tool.configEnv!!)
        }
    }
}

@Composable
private fun SkillsCard(skills: List<MobileWorkbenchSkillSummary>, onRefresh: () -> Unit, onClick: (() -> Unit)? = null) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(PanelBackground)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Skills", color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Text("已安装技能与本地发现结果", color = MutedText, fontSize = 12.sp, modifier = Modifier.padding(top = 3.dp))
            }
            TextButton(onClick = onRefresh) { Text("同步", color = TgBlue) }
        }
        if (skills.isEmpty()) {
            Text("暂无技能。可以在电脑端安装后同步到手机查看。", color = MutedText, fontSize = 12.sp)
        } else {
            skills.take(5).forEach { skill ->
                SkillRow(skill = skill)
            }
        }
    }
}

@Composable
private fun SkillRow(skill: MobileWorkbenchSkillSummary) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(PanelElevated)
            .padding(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            modifier = Modifier
                .size(34.dp)
                .clip(CircleShape)
                .background(ProfileBlue),
            contentAlignment = Alignment.Center,
        ) {
            Text("S", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 13.sp)
        }
        Spacer(modifier = Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(skill.name, color = Ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                skill.description.ifBlank { skill.id },
                modifier = Modifier.padding(top = 2.dp),
                color = MutedText,
                fontSize = 11.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun RuntimeInfoCard(
    provider: String,
    model: String,
    source: String,
    apiKeyConfigured: Boolean,
    onClick: (() -> Unit)? = null,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(PanelBackground)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text("模型运行时", color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Text("当前 LLM 连接与来源", color = MutedText, fontSize = 12.sp, modifier = Modifier.padding(top = 3.dp))
            }
            WorkbenchChip(if (apiKeyConfigured) "key" else "no key")
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            WorkbenchChip(provider.ifBlank { "unknown" })
            WorkbenchChip(model.ifBlank { "未选择模型" })
            WorkbenchChip(source.ifBlank { "env" })
        }
    }
}

@Composable
private fun OfficeNetworkCard(
    officeRunning: Boolean,
    officeUrl: String,
    officeError: String?,
    networkMessage: String,
    onStartOffice: () -> Unit,
    onOpenFirewall: () -> Unit,
    onClick: (() -> Unit)? = null,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(PanelBackground)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text("办公室", color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Text(
                    if (officeRunning) "Star Office 正在运行" else "Star Office 未启动",
                    modifier = Modifier.padding(top = 3.dp),
                    color = if (officeRunning) TgBlue else MutedText,
                    fontSize = 12.sp,
                )
            }
            WorkbenchChip(if (officeRunning) "running" else "stopped")
        }
        if (officeUrl.isNotBlank()) {
            Text(officeUrl, color = MutedText, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (!officeError.isNullOrBlank()) {
            Text(officeError, color = Color(0xFFB42318), fontSize = 11.sp, lineHeight = 16.sp)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = onStartOffice,
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = TgBlue),
            ) {
                Text("启动办公室")
            }
            OutlinedButton(onClick = onOpenFirewall, modifier = Modifier.weight(1f)) {
                Text("开放端口")
            }
        }
        Text(networkMessage, color = MutedText, fontSize = 11.sp, lineHeight = 16.sp)
    }
}

@Composable
private fun WorkbenchChip(text: String) {
    Text(
        text = text,
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(PanelElevated)
            .padding(horizontal = 9.dp, vertical = 4.dp),
        color = Ink,
        fontSize = 10.sp,
        maxLines = 1,
    )
}

private fun fallbackWorkbenchWorkspaces(state: MobileUiState): List<MobileWorkbenchWorkspaceSummary> {
    val sessionsByWorkspace = state.sessions.groupingBy { it.workspaceId.orEmpty() }.eachCount()
    val agentsByWorkspace = state.agents.groupingBy { it.workspaceId }.eachCount()
    return state.workspaces.map { workspace ->
        MobileWorkbenchWorkspaceSummary(
            id = workspace.id,
            name = workspace.name,
            goal = workspace.goal,
            projectPath = workspace.projectPath,
            agentCount = agentsByWorkspace[workspace.id] ?: 0,
            taskCount = 0,
            sessionCount = sessionsByWorkspace[workspace.id] ?: 0,
            activeRunCount = 0,
            groupSessionId = null,
            updatedAt = workspace.updatedAt,
        )
    }
}

private fun buildGroupProgressSnapshots(
    state: MobileUiState,
    tasks: List<MobileWorkbenchTaskSummary>,
    runs: List<MobileWorkbenchRunSummary>,
): List<GroupProgressSnapshot> {
    val workspacesById = state.workspaces.associateBy { it.id }
    val agentsById = state.agents.associateBy { it.id }
    val runsById = runs.associateBy { it.id }
    val runsByGroupSessionId = runs
        .filter { it.groupSessionId.isNotBlank() }
        .associateBy { it.groupSessionId }
    val latestRunByWorkspaceId = runs
        .groupBy { it.workspaceId }
        .mapValues { (_, workspaceRuns) -> workspaceRuns.maxByOrNull { it.updatedAt.ifBlank { it.createdAt } } }
    val tasksByGroup = tasks.groupBy { groupProgressKey(it) }.toMutableMap()

    runs.forEach { run ->
        val representedByTask = tasks.any { task ->
            task.runId == run.id ||
                (run.groupSessionId.isNotBlank() && task.groupSessionId == run.groupSessionId)
        }
        if (!representedByTask) {
            tasksByGroup.putIfAbsent(runGroupKey(run), emptyList())
        }
    }

    return tasksByGroup.map { (groupId, groupTasks) ->
        val run = groupTasks.firstNotNullOfOrNull { task ->
            task.runId?.let { runsById[it] }
        } ?: groupTasks.firstNotNullOfOrNull { task ->
            task.groupSessionId?.let { runsByGroupSessionId[it] }
        } ?: groupTasks.firstNotNullOfOrNull { task ->
            latestRunByWorkspaceId[task.workspaceId]
        } ?: runs.firstOrNull { runGroupKey(it) == groupId }

        val workspaceId = groupTasks.firstOrNull()?.workspaceId ?: run?.workspaceId
        val workspace = workspaceId?.let { workspacesById[it] }
        val status = groupProgressStatus(groupTasks, run)
        val childProgress = buildChildAgentProgressSnapshots(groupTasks, agentsById, workspacesById)

        GroupProgressSnapshot(
            id = groupId,
            workspaceId = workspaceId,
            workspace = workspace,
            run = run,
            title = run?.sessionTitle?.takeIf { it.isNotBlank() }
                ?: groupTasks.firstOrNull { it.sessionTitle.isNotBlank() }?.sessionTitle
                ?: workspace?.name?.takeIf { it.isNotBlank() }
                ?: groupTasks.firstOrNull()?.workspaceName?.takeIf { it.isNotBlank() }
                ?: "群聊进度",
            status = status,
            progressPercent = groupProgressPercent(groupTasks, status),
            attentionCount = groupTasks.count { taskRequiresAttention(it) },
            activeCount = groupTasks.count { it.status in setOf("pending", "running", "blocked") },
            completedCount = groupTasks.count { it.status in setOf("done", "completed") },
            updatedAt = groupProgressUpdatedAt(groupTasks, run),
            childProgress = childProgress,
        )
    }.sortedWith(
        compareBy<GroupProgressSnapshot> { groupStatusSortKey(it.status) }
            .thenByDescending { it.updatedAt },
    )
}

private fun buildChildAgentProgressSnapshots(
    tasks: List<MobileWorkbenchTaskSummary>,
    agentsById: Map<String, WorkspaceAgent>,
    workspacesById: Map<String, Workspace>,
): List<ChildAgentProgressSnapshot> {
    return tasks
        .groupBy { childAgentProgressKey(it) }
        .mapNotNull { (_, agentTasks) ->
            val task = agentTasks.maxByOrNull { taskSortKey(it) } ?: return@mapNotNull null
            val agent = task.agentId?.let { agentsById[it] }
            ChildAgentProgressSnapshot(
                agent = agent,
                workspace = workspacesById[task.workspaceId],
                task = task,
                fallbackAgentId = task.agentId?.takeIf { it.isNotBlank() } ?: task.id,
                fallbackName = agent?.name?.takeIf { it.isNotBlank() }
                    ?: task.agentName.takeIf { it.isNotBlank() }
                    ?: "Agent",
                fallbackRole = agent?.role?.takeIf { it.isNotBlank() }
                    ?: task.agentRole.takeIf { it.isNotBlank() }
                    ?: agent?.roleType.orEmpty(),
            )
        }
        .sortedWith(
            compareBy<ChildAgentProgressSnapshot>(
                { childStatusSortKey(it.task?.status ?: "idle") },
                { it.task?.orderIdx ?: it.agent?.orderIdx ?: 9999 },
                { it.fallbackName.ifBlank { "Agent" } },
            ),
        )
}

private fun groupProgressKey(task: MobileWorkbenchTaskSummary): String {
    val groupSessionId = task.groupSessionId?.takeIf { it.isNotBlank() }
    val runId = task.runId?.takeIf { it.isNotBlank() }
    return when {
        groupSessionId != null -> "group:$groupSessionId"
        runId != null -> "run:$runId"
        task.workspaceId.isNotBlank() -> "workspace:${task.workspaceId}"
        else -> "task:${task.id}"
    }
}

private fun runGroupKey(run: MobileWorkbenchRunSummary): String {
    return run.groupSessionId.takeIf { it.isNotBlank() }?.let { "group:$it" } ?: "run:${run.id}"
}

private fun childAgentProgressKey(task: MobileWorkbenchTaskSummary): String {
    return task.agentId?.takeIf { it.isNotBlank() }?.let { "agent:$it" } ?: "task:${task.id}"
}

private fun groupProgressStatus(
    tasks: List<MobileWorkbenchTaskSummary>,
    run: MobileWorkbenchRunSummary?,
): String {
    val runStatus = run?.status?.trim()?.lowercase().orEmpty()
    if (tasks.isEmpty()) return runStatus.ifBlank { "idle" }
    val statuses = tasks.map { it.status.trim().lowercase() }
    return when {
        runStatus == "failed" -> "failed"
        runStatus == "blocked" -> "blocked"
        statuses.any { it == "failed" } -> "failed"
        statuses.any { it == "blocked" } || tasks.any { taskRequiresAttention(it) } -> "blocked"
        statuses.any { it == "running" } -> "running"
        runStatus in setOf("planning", "synthesizing") -> runStatus
        statuses.any { it == "pending" } -> "pending"
        statuses.all { it in setOf("done", "completed", "skipped") } -> {
            if (runStatus in setOf("completed", "done", "cancelled")) runStatus else "done"
        }
        runStatus.isNotBlank() -> runStatus
        else -> statuses.firstOrNull()?.ifBlank { "idle" } ?: "idle"
    }
}

private fun groupProgressPercent(tasks: List<MobileWorkbenchTaskSummary>, status: String): Int {
    if (tasks.isNotEmpty()) {
        return (tasks.sumOf { taskProgressPercent(it) } / tasks.size).coerceIn(0, 100)
    }
    return when (status.trim().lowercase()) {
        "done", "completed" -> 100
        "synthesizing" -> 82
        "running" -> 36
        "planning" -> 12
        "pending" -> 5
        "blocked", "failed" -> 8
        else -> 0
    }
}

private fun groupProgressUpdatedAt(
    tasks: List<MobileWorkbenchTaskSummary>,
    run: MobileWorkbenchRunSummary?,
): String {
    return tasks.maxOfOrNull { taskSortKey(it) }
        ?: run?.updatedAt?.ifBlank { run.createdAt }
        ?: ""
}

private fun groupStatusSortKey(status: String): Int {
    return when (status.trim().lowercase()) {
        "blocked", "failed" -> 0
        "running" -> 1
        "planning", "pending", "synthesizing" -> 2
        "done", "completed" -> 3
        else -> 4
    }
}

private fun childStatusSortKey(status: String): Int {
    return when (status.trim().lowercase()) {
        "blocked", "failed" -> 0
        "running" -> 1
        "planning", "pending", "synthesizing" -> 2
        "done", "completed" -> 3
        else -> 4
    }
}

private fun taskRequiresAttention(task: MobileWorkbenchTaskSummary): Boolean {
    if (task.requiresAttention) return true
    if (task.status in setOf("blocked", "failed")) return true
    val text = listOf(task.progressStatus, task.errorLog.orEmpty()).joinToString("\n").lowercase()
    return listOf("确认", "审批", "复核", "冲突", "review", "approval", "approve", "human")
        .any { text.contains(it) }
}

private fun taskProgressPercent(task: MobileWorkbenchTaskSummary): Int {
    val stored = task.progressPercent.coerceIn(0, 100)
    return when (task.status) {
        "done", "completed" -> 100
        "running" -> stored.coerceAtLeast(12)
        "blocked", "failed" -> stored.coerceAtLeast(8)
        "pending" -> stored.coerceAtMost(5)
        else -> stored
    }
}

private fun taskSortKey(task: MobileWorkbenchTaskSummary): String {
    return task.updatedAt.ifBlank { task.startedAt.orEmpty().ifBlank { task.createdAt } }
}

private fun workbenchStatusLabel(status: String): String {
    return when (status.trim().lowercase()) {
        "planning" -> "规划中"
        "pending" -> "待开始"
        "running" -> "运行中"
        "synthesizing" -> "汇总中"
        "completed", "done" -> "已完成"
        "failed" -> "失败"
        "cancelled" -> "已取消"
        "blocked" -> "待处理"
        "skipped" -> "已跳过"
        "idle" -> "空闲"
        else -> status.ifBlank { "未知" }
    }
}

private fun workbenchStatusColor(status: String): Color {
    return when (status.trim().lowercase()) {
        "running", "planning", "synthesizing" -> TgBlue
        "completed", "done" -> TgGreen
        "blocked" -> WorkAmber
        "failed" -> Color(0xFFFF6B78)
        "cancelled", "skipped", "idle" -> MutedText
        else -> MutedText
    }
}

private fun formatWorkbenchDate(value: String): String {
    return value.substringBefore('T').ifBlank { value }
}

@Composable
private fun ProfileScreen(
    state: MobileUiState,
    onDisconnect: () -> Unit,
    onScanQr: () -> Unit,
    onRefresh: () -> Unit,
    onOpenModelManagement: () -> Unit,
    onOpenCodingTools: () -> Unit,
    onOpenSkillsMarket: () -> Unit,
    onOpenOffice: () -> Unit,
) {
    val workbench = state.workbench
    val toolItems = workbench?.codingTools?.items.orEmpty()
    val readyToolCount = toolItems.count { it.ready }
    val runtime = workbench?.runtime
    val office = workbench?.office
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .background(SoftFill),
        verticalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        // Profile hero section (Telegram-style big avatar)
        item {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(PanelBackground)
                    .padding(vertical = 20.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                // Big circular avatar
                Box {
                    Box(
                        modifier = Modifier
                            .size(80.dp)
                            .clip(CircleShape)
                            .background(TgBlue),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (!DataUrlAvatarImage(avatar = state.currentUser.avatar?.trim().orEmpty())) {
                            Text(
                                userAvatarLabel(state.currentUser),
                                color = Color.White,
                                fontWeight = FontWeight.Bold,
                                fontSize = 28.sp,
                            )
                        }
                    }
                    // Online indicator
                    Box(
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .size(20.dp)
                            .clip(CircleShape)
                            .background(if (state.connected) TgOnlineGreen else MutedText)
                            .border(3.dp, PanelBackground, CircleShape),
                    )
                }
                Text(
                    state.currentUser.name.ifBlank { "You" },
                    modifier = Modifier.padding(top = 12.dp),
                    color = Ink,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 20.sp,
                )
                Text(
                    if (state.connected) "已连接 · ${state.connection?.deviceName ?: "电脑端"}" else "未连接",
                    modifier = Modifier.padding(top = 4.dp),
                    color = if (state.connected) TgOnlineGreen else MutedText,
                    fontSize = 14.sp,
                )
            }
        }

        // Stats row
        item {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(PanelBackground)
                    .padding(horizontal = 24.dp, vertical = 14.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                ProfileStat("会话", state.sessions.size.toString())
                ProfileStat("状态", if (state.connected) "在线" else "离线")
                ProfileStat("Agent", state.contacts.size.toString())
            }
        }

        // Spacer
        item {
            Spacer(modifier = Modifier
                .fillMaxWidth()
                .height(24.dp)
                .background(SoftFill))
        }

        // Info section
        item {
            Column(modifier = Modifier.background(PanelBackground)) {
                ProfileSettingsRow(
                    label = "设备名",
                    value = state.connection?.deviceName ?: "Android",
                )
                ProfileSettingsDivider()
                ProfileSettingsRow(
                    label = "连接状态",
                    value = if (state.connected) "电脑端在线" else "未连接",
                )
                ProfileSettingsDivider()
                ProfileSettingsRow(
                    label = "服务地址",
                    value = state.connection?.baseUrl ?: "等待扫码配对",
                )
            }
        }

        // Spacer
        item {
            Spacer(modifier = Modifier
                .fillMaxWidth()
                .height(24.dp)
                .background(SoftFill))
        }

        // Desktop capability settings
        item {
            Column(modifier = Modifier.background(PanelBackground)) {
                ProfileSettingsNavAction(
                    label = "模型管理",
                    value = listOf(runtime?.provider, runtime?.model).filter { !it.isNullOrBlank() }.joinToString(" · ")
                        .ifBlank { "配置供应商与模型" },
                    icon = LineIconKind.Bot,
                    onClick = onOpenModelManagement,
                )
                ProfileSettingsDivider()
                ProfileSettingsNavAction(
                    label = "Coding Tools",
                    value = if (toolItems.isEmpty()) "检测 CLI 与执行配置" else "$readyToolCount/${toolItems.size} ready",
                    icon = LineIconKind.Tools,
                    onClick = onOpenCodingTools,
                )
                ProfileSettingsDivider()
                ProfileSettingsNavAction(
                    label = "Skills 市场",
                    value = "${workbench?.skills?.size ?: 0} 个已发现技能",
                    icon = LineIconKind.Skills,
                    onClick = onOpenSkillsMarket,
                )
                ProfileSettingsDivider()
                ProfileSettingsNavAction(
                    label = "办公室与网络",
                    value = if (office?.running == true) "Star Office 运行中" else "办公室服务未启动",
                    icon = LineIconKind.Office,
                    onClick = onOpenOffice,
                )
                ProfileSettingsDivider()
                ProfileSettingsNavAction(
                    label = "同步桌面设置",
                    value = if (state.workbenchLoading) "同步中" else "刷新移动端缓存",
                    icon = LineIconKind.History,
                    onClick = onRefresh,
                )
            }
        }

        item {
            Spacer(modifier = Modifier
                .fillMaxWidth()
                .height(24.dp)
                .background(SoftFill))
        }

        // Actions section
        item {
            Column(modifier = Modifier.background(PanelBackground)) {
                ProfileSettingsAction(
                    label = "扫码连接电脑端",
                    icon = LineIconKind.Scan,
                    accent = true,
                    onClick = onScanQr,
                )
                ProfileSettingsDivider()
                ProfileSettingsAction(
                    label = "断开电脑端",
                    icon = LineIconKind.Disconnect,
                    accent = false,
                    enabled = state.connection != null,
                    onClick = onDisconnect,
                )
            }
        }

        // Info text
        item {
            Text(
                text = if (state.connected) "手机端会跟随电脑端实时同步会话、消息和 Agent 状态。" else "打开电脑端设置里的移动端连接，扫码后即可同步。",
                color = MutedText,
                fontSize = 13.sp,
                lineHeight = 19.sp,
                modifier = Modifier.padding(horizontal = 24.dp, vertical = 16.dp),
            )
        }
        item { Spacer(modifier = Modifier.height(92.dp)) }
    }
}

@Composable
private fun ProfileStat(label: String, value: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, color = Ink, fontWeight = FontWeight.Bold, fontSize = 18.sp)
        Text(label, modifier = Modifier.padding(top = 2.dp), color = MutedText, fontSize = 12.sp)
    }
}

@Composable
private fun ProfileSettingsRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = Ink, fontSize = 15.sp, modifier = Modifier.width(80.dp))
        Text(
            value,
            color = MutedText,
            fontSize = 15.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun ProfileSettingsNavAction(
    label: String,
    value: String,
    icon: LineIconKind,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(TgBlueLight),
            contentAlignment = Alignment.Center,
        ) {
            LineIcon(kind = icon, color = TgBlue, modifier = Modifier.size(19.dp))
        }
        Spacer(modifier = Modifier.width(14.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(label, color = Ink, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                value.ifBlank { "未配置" },
                modifier = Modifier.padding(top = 2.dp),
                color = MutedText,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text("›", color = MutedText, fontSize = 18.sp)
    }
}

@Composable
private fun ProfileSettingsDivider() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp)
            .height(0.5.dp)
            .background(Hairline),
    )
}

@Composable
private fun ProfileSettingsAction(label: String, icon: LineIconKind, accent: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    val iconColor = when {
        accent -> TgBlue
        enabled -> Color(0xFFFF6B78)
        else -> MutedText
    }
    val iconBg = when {
        accent -> TgBlueLight
        enabled -> Color(0xFF3A1F25)
        else -> SoftFill
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(iconBg),
            contentAlignment = Alignment.Center,
        ) {
            LineIcon(kind = icon, color = iconColor, modifier = Modifier.size(19.dp))
        }
        Spacer(modifier = Modifier.width(14.dp))
        Text(
            label,
            color = if (accent) TgBlue else if (enabled) Color(0xFFFF6B78) else MutedText,
            fontSize = 15.sp,
            fontWeight = FontWeight.Normal,
        )
    }
}

@Composable
private fun FeatureHero(title: String, subtitle: String, icon: LineIconKind, action: String, onAction: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(PanelBackground)
            .padding(horizontal = 16.dp, vertical = 16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(34.dp)
                    .clip(RoundedCornerShape(11.dp))
                    .background(TgBlueLight),
                contentAlignment = Alignment.Center,
            ) {
                LineIcon(kind = icon, color = TgBlue, modifier = Modifier.size(20.dp))
            }
            Spacer(modifier = Modifier.width(10.dp))
            Text(title, color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
        }
        Text(subtitle, modifier = Modifier.padding(top = 8.dp), color = MutedText, fontSize = 14.sp, lineHeight = 20.sp)
        Button(
            onClick = onAction,
            modifier = Modifier.padding(top = 12.dp),
            colors = ButtonDefaults.buttonColors(containerColor = TgBlue),
            shape = RoundedCornerShape(20.dp),
        ) {
            Text(action)
        }
    }
}

@Composable
private fun MetricCard(label: String, value: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(10.dp))
            .background(SoftFill)
            .padding(14.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(value, color = TgBlue, fontWeight = FontWeight.Bold, fontSize = 22.sp)
        Text(label, modifier = Modifier.padding(top = 4.dp), color = MutedText, fontSize = 12.sp)
    }
}

@Composable
private fun QuickEntry(title: String, desc: String, icon: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(PanelBackground)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(icon, color = Ink, fontWeight = FontWeight.Bold, fontSize = 18.sp)
        Spacer(modifier = Modifier.width(10.dp))
        Column {
            Text(text = title, color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            Text(text = desc, modifier = Modifier.padding(top = 3.dp), color = MutedText, fontSize = 12.sp)
        }
    }
}

@Composable
private fun ProfileHeroCard(connected: Boolean, baseUrl: String) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(PanelBackground)
            .padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box {
                Box(
                    modifier = Modifier
                        .size(56.dp)
                        .clip(CircleShape)
                        .background(TgBlue),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("AH", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 20.sp)
                }
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .size(16.dp)
                        .clip(CircleShape)
                        .background(if (connected) TgOnlineGreen else MutedText)
                        .border(2.dp, PanelBackground, CircleShape),
                )
            }
            Spacer(modifier = Modifier.width(14.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text("AgentHub Mobile", color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, maxLines = 1)
                Text(
                    baseUrl,
                    modifier = Modifier.padding(top = 2.dp),
                    color = MutedText,
                    fontSize = 13.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Row(
            modifier = Modifier
                .padding(top = 14.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(if (connected) TgBlueLight else SoftFill)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(if (connected) TgOnlineGreen else MutedText),
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text(
                if (connected) "电脑端在线" else "等待扫码连接电脑端",
                color = if (connected) TgBlue else MutedText,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
            )
        }
    }
}

@Composable
private fun ProfileMetricTile(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    accent: Color = Ink,
) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(18.dp))
            .background(PanelBackground)
            .border(0.5.dp, Hairline, RoundedCornerShape(18.dp))
            .padding(horizontal = 12.dp, vertical = 12.dp),
    ) {
        Text(value, color = accent, fontWeight = FontWeight.Bold, fontSize = 18.sp, maxLines = 1)
        Text(label, modifier = Modifier.padding(top = 4.dp), color = MutedText, fontSize = 11.sp, maxLines = 1)
    }
}

@Composable
private fun ProfileInfoCard(rows: List<Pair<String, String>>) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(PanelBackground)
            .border(0.5.dp, Hairline, RoundedCornerShape(20.dp)),
    ) {
        rows.forEachIndexed { index, row ->
            ProfileInfoRow(label = row.first, value = row.second)
            if (index < rows.lastIndex) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 14.dp)
                        .height(0.5.dp)
                        .background(Hairline),
                )
            }
        }
    }
}

@Composable
private fun ProfileInfoRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = MutedText, fontSize = 14.sp, modifier = Modifier.weight(1f))
        Text(
            value,
            color = Ink,
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth(0.62f),
        )
    }
}

@Composable
private fun ProfilePrimaryAction(text: String, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(48.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(TgBlue)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun ProfileSecondaryAction(text: String, enabled: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(46.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(if (enabled) PanelBackground else SoftFill)
            .border(0.8.dp, Hairline, RoundedCornerShape(16.dp))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            color = if (enabled) Ink else MutedText,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun MobileChatComposer(
    value: String,
    onValueChange: (String) -> Unit,
    onFocusChanged: (Boolean) -> Unit,
    onSend: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val canSend = value.trim().isNotEmpty()

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 10.dp)
            .clip(RoundedCornerShape(28.dp))
            .background(BottomGlass)
            .border(0.5.dp, Hairline, RoundedCornerShape(28.dp))
            .padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        Box(
            modifier = Modifier
                .weight(1f)
                .padding(end = 6.dp)
                .clip(RoundedCornerShape(24.dp))
                .background(PanelElevated)
                .border(0.5.dp, Hairline, RoundedCornerShape(24.dp))
                .padding(horizontal = 14.dp, vertical = 10.dp),
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 22.dp, max = 108.dp)
                    .onFocusChanged { onFocusChanged(it.isFocused) },
                textStyle = TextStyle(color = Ink, fontSize = 16.sp, lineHeight = 22.sp),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { if (canSend) onSend() }),
                decorationBox = { innerTextField ->
                    Box {
                        if (value.isBlank()) {
                            Text("消息", color = MutedText, fontSize = 16.sp)
                        }
                        innerTextField()
                    }
                },
            )
        }

        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(if (canSend) TgBlue else PanelElevated)
                .clickable(enabled = canSend, onClick = onSend),
            contentAlignment = Alignment.Center,
        ) {
            if (canSend) {
                LineIcon(kind = LineIconKind.Send, color = Color.White, modifier = Modifier.size(18.dp))
            } else {
                Box(
                    modifier = Modifier
                        .size(16.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(MutedText.copy(alpha = 0.35f)),
                )
            }
        }
    }
}

@Composable
private fun ComposerRoundButton(label: String, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(38.dp)
            .clip(CircleShape)
            .background(SoftFill)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (label == "+") {
            PlusGlyph(color = Ink, modifier = Modifier.size(16.dp))
        } else {
            Text(label, color = Ink, fontSize = 20.sp, fontWeight = FontWeight.Medium)
        }
    }
}

@Composable
private fun ChatComposer(
    value: String,
    onValueChange: (String) -> Unit,
    onSend: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(PanelBackground)
            .padding(horizontal = 16.dp, vertical = 13.dp),
    ) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 42.dp, max = 104.dp),
            textStyle = TextStyle(color = Ink, fontSize = 15.sp, lineHeight = 22.sp),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { onSend() }),
            decorationBox = { innerTextField ->
                Box {
                    if (value.isBlank()) {
                        Text("发消息给 AgentHub，可 @ Agent", color = MutedText, fontSize = 14.sp)
                    }
                    innerTextField()
                }
            },
        )
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            listOf("+", "⊞", "@").forEach { ComposerTool(it) }
            Spacer(modifier = Modifier.weight(1f))
            Box(
                modifier = Modifier
                    .size(38.dp)
                    .clip(CircleShape)
                    .background(if (value.isBlank()) PanelElevated else TgBlue)
            .clickable(enabled = value.isNotBlank(), onClick = onSend),
        contentAlignment = Alignment.Center,
    ) {
                LineIcon(kind = LineIconKind.Send, color = Color.White, modifier = Modifier.size(18.dp))
            }
        }
    }
}

@Composable
private fun ComposerTool(label: String) {
    Text(
        text = label,
        modifier = Modifier.padding(end = 18.dp, top = 8.dp, bottom = 2.dp),
        color = Color(0xFF6A6A64),
        fontSize = 20.sp,
    )
}

@Composable
private fun MessageBubble(
    message: Message,
    streaming: Boolean,
    streamingCodeAgentRun: JsonObject?,
    baseUrl: String?,
    workspaceId: String?,
    currentUser: MobileUserProfile,
    onPreviewArtifact: (MobileArtifact) -> Unit,
) {
    val isUser = message.senderType == "user"
    val artifacts = remember(message.metadata, streamingCodeAgentRun, workspaceId) {
        readArtifacts(message.metadata, streamingCodeAgentRun, workspaceId)
    }
    val codeAgentRun = remember(message.metadata, streamingCodeAgentRun) {
        streamingCodeAgentRun ?: message.metadata?.get("codeAgentRun")?.asJsonObject()
    }
    val messageTime = remember(message) {
        try {
            message.createdAt?.substringAfter('T')?.take(5) ?: ""
        } catch (_: Exception) { "" }
    }
    val bubbleShape = RoundedCornerShape(
        topStart = if (isUser) 18.dp else 6.dp,
        topEnd = if (isUser) 6.dp else 18.dp,
        bottomStart = 18.dp,
        bottomEnd = 18.dp,
    )
    val bubbleTextColor = if (isUser) Color.White else Ink

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 1.dp),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        if (!isUser) {
            Box(
                modifier = Modifier
                    .size(32.dp)
                    .clip(CircleShape)
                    .background(TgBlue),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    senderLabel(message).take(1),
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 13.sp,
                )
            }
            Spacer(modifier = Modifier.width(6.dp))
        }

        Column(
            modifier = Modifier
                .fillMaxWidth(0.78f)
                .clip(bubbleShape)
                .background(if (isUser) TgSentBg else TgReceivedBg)
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            if (!isUser) {
                Text(
                    text = senderLabel(message),
                    color = TgBlue,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            Column(
                modifier = Modifier.padding(top = if (isUser) 2.dp else 4.dp),
            ) {
                MessageBodyContent(content = message.content.ifBlank { " " }, textColor = bubbleTextColor)
                if (messageTime.isNotBlank()) {
                    Text(
                        text = messageTime,
                        color = if (isUser) Color.White.copy(alpha = 0.72f) else MutedText,
                        fontSize = 11.sp,
                        modifier = Modifier.align(Alignment.End).padding(top = 3.dp),
                    )
                }
            }
            if (streaming && !isUser) {
                StreamingStatusBar(
                    text = if (artifacts.isEmpty()) "正在输入..." else "正在生成产物...",
                )
            }
            if (!isUser && codeAgentRun != null) {
                CodeAgentRunMiniCard(run = codeAgentRun)
            }
            if (artifacts.isNotEmpty()) {
                ArtifactStrip(artifacts = artifacts, onPreview = onPreviewArtifact)
            }
        }

        if (isUser) {
            Spacer(modifier = Modifier.width(6.dp))
            UserMessageAvatar(profile = currentUser)
        }
    }
}

@Composable
private fun UserMessageAvatar(profile: MobileUserProfile) {
    val avatar = profile.avatar?.trim().orEmpty()
    Box(
        modifier = Modifier
            .size(32.dp)
            .clip(CircleShape)
            .background(Color(0xFF5B6D8A)),
        contentAlignment = Alignment.Center,
    ) {
        if (!DataUrlAvatarImage(avatar = avatar)) {
            Text(
                text = userAvatarLabel(profile),
                color = Color.White,
                fontWeight = FontWeight.Bold,
                fontSize = 13.sp,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun DataUrlAvatarImage(avatar: String): Boolean {
    val bitmap = remember(avatar) { decodeDataUrlBitmap(avatar) }
    if (bitmap == null) return false
    Image(
        bitmap = bitmap.asImageBitmap(),
        contentDescription = "User avatar",
        modifier = Modifier.fillMaxSize(),
        contentScale = ContentScale.Crop,
    )
    return true
}

@Composable
private fun MessageBodyContent(content: String, textColor: Color) {
    val segments = remember(content) { splitMessageBody(content) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        segments.forEach { segment ->
            if (segment.isCode) {
                CodeBlockPreview(language = segment.language, code = segment.text)
            } else if (segment.text.isNotBlank()) {
                MarkdownText(text = segment.text, textColor = textColor)
            }
        }
    }
}

@Composable
private fun MarkdownText(text: String, textColor: Color) {
    val blocks = remember(text) { parseMarkdownBlocks(text) }
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        blocks.forEach { block ->
            when (block.type) {
                MarkdownBlockType.Spacer -> Spacer(modifier = Modifier.height(4.dp))
                MarkdownBlockType.Divider -> Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 5.dp)
                        .height(0.5.dp)
                        .background(textColor.copy(alpha = 0.28f)),
                )
                MarkdownBlockType.Heading -> {
                    val level = block.level.coerceIn(1, 3)
                    Text(
                        text = inlineMarkdown(block.text, textColor),
                        color = textColor,
                        fontSize = when (level) {
                            1 -> 19.sp
                            2 -> 17.sp
                            else -> 16.sp
                        },
                        lineHeight = when (level) {
                            1 -> 25.sp
                            2 -> 23.sp
                            else -> 22.sp
                        },
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(top = if (level == 1) 3.dp else 1.dp, start = ((level - 1) * 4).dp),
                    )
                }
                MarkdownBlockType.Bullet -> MarkdownListRow(
                    marker = "",
                    text = block.text,
                    textColor = textColor,
                    ordered = false,
                )
                MarkdownBlockType.Numbered -> MarkdownListRow(
                    marker = block.marker,
                    text = block.text,
                    textColor = textColor,
                    ordered = true,
                )
                MarkdownBlockType.Quote -> Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 1.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .padding(top = 2.dp)
                            .width(3.dp)
                            .height(20.dp)
                            .clip(RoundedCornerShape(999.dp))
                            .background(TgBlue.copy(alpha = 0.72f)),
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = inlineMarkdown(block.text, textColor),
                        color = textColor.copy(alpha = 0.88f),
                        fontSize = 14.sp,
                        lineHeight = 20.sp,
                        modifier = Modifier.weight(1f),
                    )
                }
                MarkdownBlockType.Paragraph -> Text(
                    text = inlineMarkdown(block.text, textColor),
                    color = textColor,
                    fontSize = 15.sp,
                    lineHeight = 21.sp,
                )
            }
        }
    }
}

@Composable
private fun MarkdownListRow(marker: String, text: String, textColor: Color, ordered: Boolean) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 3.dp),
        verticalAlignment = Alignment.Top,
    ) {
        if (ordered) {
            Text(
                text = marker,
                color = textColor.copy(alpha = 0.78f),
                fontSize = 14.sp,
                lineHeight = 21.sp,
                modifier = Modifier.width(24.dp),
            )
        } else {
            Box(
                modifier = Modifier
                    .padding(top = 9.dp, end = 11.dp, start = 5.dp)
                    .size(4.dp)
                    .clip(CircleShape)
                    .background(textColor.copy(alpha = 0.82f)),
            )
        }
        Text(
            text = inlineMarkdown(text, textColor),
            color = textColor,
            fontSize = 15.sp,
            lineHeight = 21.sp,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun CodeBlockPreview(language: String?, code: String) {
    val horizontalState = rememberScrollState()
    val verticalState = rememberScrollState()
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(Color(0xFF101821))
            .border(0.5.dp, Hairline, RoundedCornerShape(10.dp)),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(PanelElevated)
                .padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                language?.ifBlank { null } ?: "code",
                color = MutedText,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text("桌面端查看完整代码", color = MutedText, fontSize = 10.sp)
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 220.dp)
                .horizontalScroll(horizontalState)
                .verticalScroll(verticalState)
                .padding(horizontal = 10.dp, vertical = 9.dp),
        ) {
            Text(
                code.ifBlank { " " },
                color = Ink,
                fontSize = 12.sp,
                lineHeight = 18.sp,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

@Composable
private fun CodeAgentRunMiniCard(run: JsonObject) {
    val runtime = run.stringValue("runtime")
    val status = run.stringValue("status")
    val runtimeLabel = codeAgentRuntimeLabel(runtime)
    val statusLabel = codeAgentStatusLabel(status, run.booleanValue("partialSuccess"))
    val files = run["files"]?.asJsonArray()?.size ?: 0
    val commands = run["commands"]?.asJsonArray()?.size ?: 0
    val toolCalls = run["toolCalls"]?.asJsonArray()?.size ?: 0
    val artifacts = run["artifacts"]?.asJsonArray()?.size ?: 0
    val durationMs = run.longValue("durationMs") ?: 0L
    val exitCode = run.intValue("exitCode")
    val reviewRequired = run.booleanValue("reviewRequired")
    val warning = run.stringValue("warning") ?: run.stringValue("diagnostics")

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 8.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(PanelElevated)
            .border(0.5.dp, Hairline, RoundedCornerShape(12.dp))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(codeAgentStatusColor(status, reviewRequired)),
            )
            Spacer(modifier = Modifier.width(7.dp))
            Text(
                runtimeLabel,
                color = Ink,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            MiniRunChip(statusLabel, codeAgentStatusColor(status, reviewRequired))
        }

        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (commands > 0) MiniRunChip("$commands 命令", MutedText)
            if (files > 0) MiniRunChip("$files 文件", TgBlue)
            if (toolCalls > 0) MiniRunChip("$toolCalls 工具", WorkAmber)
            if (artifacts > 0) MiniRunChip("$artifacts 产物", TgGreen)
        }

        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (durationMs > 0) MiniRunChip(formatDuration(durationMs), MutedText)
            if (exitCode != null && exitCode != 0) MiniRunChip("exit $exitCode", Color(0xFFFF6B78))
            if (reviewRequired) MiniRunChip("待复核", WorkAmber)
        }

        if (!warning.isNullOrBlank()) {
            Text(
                warning.take(180),
                color = if (status == "failed" || status == "timed-out") Color(0xFFFF9AA3) else MutedText,
                fontSize = 11.sp,
                lineHeight = 16.sp,
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun MiniRunChip(text: String, color: Color) {
    Text(
        text,
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(color.copy(alpha = 0.14f))
            .padding(horizontal = 7.dp, vertical = 3.dp),
        color = color,
        fontSize = 10.sp,
        fontWeight = FontWeight.Medium,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
private fun StreamingStatusBar(text: String) {
    Row(
        modifier = Modifier
            .padding(top = 6.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(TgBlueLight)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(TgBlue),
        )
        Spacer(modifier = Modifier.width(5.dp))
        Text(text, color = TgBlue, fontSize = 11.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun TypingIndicator() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.Start,
    ) {
        // Agent avatar
        Box(
            modifier = Modifier
                .size(32.dp)
                .clip(CircleShape)
                .background(TgBlue),
            contentAlignment = Alignment.Center,
        ) {
            Text("A", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 13.sp)
        }
        Spacer(modifier = Modifier.width(6.dp))
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(4.dp, 16.dp, 16.dp, 16.dp))
                .background(TgReceivedBg)
                .border(0.5.dp, Hairline, RoundedCornerShape(4.dp, 16.dp, 16.dp, 16.dp))
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Animated dots
            Text("正在输入", color = TgBlue, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            Spacer(modifier = Modifier.width(4.dp))
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .clip(CircleShape)
                    .background(TgBlue),
            )
        }
    }
}

@Composable
private fun ArtifactStrip(artifacts: List<MobileArtifact>, onPreview: (MobileArtifact) -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("快速预览", color = MutedText, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        artifacts.take(4).forEach { artifact ->
            ArtifactPreviewCard(artifact = artifact, onClick = { onPreview(artifact) })
        }
        if (artifacts.size > 4) {
            Text("+${artifacts.size - 4} 个产物", color = MutedText, fontSize = 12.sp)
        }
    }
}

@Composable
private fun ArtifactPreviewCard(artifact: MobileArtifact, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(PanelElevated)
            .clickable(onClick = onClick)
            .padding(horizontal = 11.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ArtifactIcon(artifact = artifact, color = TgBlue, modifier = Modifier.size(20.dp))
        Spacer(modifier = Modifier.width(9.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                artifact.title,
                color = Ink,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                artifact.subtitle,
                color = MutedText,
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text("预览", color = TgBlue, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun ArtifactIcon(artifact: MobileArtifact, color: Color, modifier: Modifier = Modifier.size(20.dp)) {
    val iconKind = when {
        artifact.icon == "deploy" -> LineIconKind.Send
        artifact.icon == "presentation" -> LineIconKind.Presentation
        artifact.icon == "workflow" -> LineIconKind.Workflow
        artifact.icon == "diff" -> LineIconKind.Diff
        artifact.icon == "image" -> LineIconKind.Image
        artifact.icon == "web" -> LineIconKind.Web
        artifact.icon == "document" -> LineIconKind.Document
        artifact.icon == "file" -> LineIconKind.File
        artifact.kind == MobileArtifactKind.Web -> LineIconKind.Web
        artifact.kind == MobileArtifactKind.Image -> LineIconKind.Image
        artifact.kind == MobileArtifactKind.Document -> LineIconKind.Document
        artifact.kind == MobileArtifactKind.Diff -> LineIconKind.Diff
        artifact.kind == MobileArtifactKind.Workflow -> LineIconKind.Workflow
        else -> LineIconKind.File
    }
    LineIcon(kind = iconKind, color = color, modifier = modifier)
}

@Composable
private fun ArtifactPreviewOverlay(
    artifact: MobileArtifact,
    baseUrl: String?,
    authToken: String?,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val absoluteUrl = remember(artifact.url, baseUrl) { absoluteArtifactUrl(baseUrl, artifact.url) }
    val webHeaders = remember(authToken) { webViewHeaders(authToken) }

    fun openExternal() {
        val url = absoluteUrl ?: return
        runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(PageBackground),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp)
                .background(PanelBackground)
                .border(0.5.dp, Hairline)
                .padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "关闭",
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .clickable(onClick = onClose)
                    .padding(horizontal = 8.dp, vertical = 7.dp),
                color = MutedText,
                fontSize = 14.sp,
            )
            Column(modifier = Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    artifact.title,
                    color = Ink,
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(artifact.subtitle, color = MutedText, fontSize = 11.sp, maxLines = 1)
            }
            Text(
                "打开",
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .clickable(enabled = absoluteUrl != null, onClick = ::openExternal)
                    .padding(horizontal = 8.dp, vertical = 7.dp),
                color = if (absoluteUrl != null) TgBlue else MutedText,
                fontSize = 14.sp,
            )
        }

        when {
            artifact.kind == MobileArtifactKind.Web && absoluteUrl != null -> {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { viewContext ->
                        WebView(viewContext).apply {
                            configurePreviewWebView()
                            loadUrl(absoluteUrl, webHeaders)
                        }
                    },
                    update = { webView ->
                        if (webView.url != absoluteUrl) webView.loadUrl(absoluteUrl, webHeaders)
                    },
                )
            }
            artifact.kind == MobileArtifactKind.Image && absoluteUrl != null -> {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { viewContext ->
                        WebView(viewContext).apply {
                            configurePreviewWebView()
                            loadUrl(absoluteUrl, webHeaders)
                        }
                    },
                    update = { webView ->
                        if (webView.url != absoluteUrl) webView.loadUrl(absoluteUrl, webHeaders)
                    },
                )
            }
            artifact.kind == MobileArtifactKind.Diff -> {
                Text(
                    text = artifact.source.orEmpty().ifBlank { "暂无 Diff 内容" },
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(16.dp),
                    color = Ink,
                    fontSize = 12.sp,
                    lineHeight = 18.sp,
                )
            }
            else -> {
                DocumentPreviewPlaceholder(
                    artifact = artifact,
                    canOpen = absoluteUrl != null,
                    onOpen = ::openExternal,
                )
            }
        }
    }
}

private fun WebView.configurePreviewWebView() {
    webViewClient = WebViewClient()
    webChromeClient = WebChromeClient()
    setBackgroundColor(android.graphics.Color.TRANSPARENT)
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.loadWithOverviewMode = true
    settings.useWideViewPort = true
    settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
}

private fun webViewHeaders(authToken: String?): Map<String, String> {
    val token = authToken?.trim()
    return if (token.isNullOrBlank()) {
        emptyMap()
    } else {
        mapOf("Authorization" to "Bearer $token")
    }
}

@Composable
private fun DocumentPreviewPlaceholder(
    artifact: MobileArtifact,
    canOpen: Boolean,
    onOpen: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 36.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            modifier = Modifier
                .size(72.dp)
                .clip(RoundedCornerShape(18.dp))
                .background(TgBlueLight),
            contentAlignment = Alignment.Center,
        ) {
            ArtifactIcon(artifact = artifact, color = TgBlue, modifier = Modifier.size(38.dp))
        }
        Text(
            artifact.title,
            modifier = Modifier.padding(top = 16.dp),
            color = Ink,
            fontWeight = FontWeight.Bold,
            fontSize = 20.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            artifact.description ?: artifact.path ?: artifact.subtitle,
            modifier = Modifier.padding(top = 10.dp),
            color = MutedText,
            fontSize = 14.sp,
            lineHeight = 22.sp,
        )
        Text(
            when (artifact.kind) {
                MobileArtifactKind.Document -> "Word、PPT、PDF 等文档会通过系统预览器打开。"
                MobileArtifactKind.Workflow -> "这是 Agent 产出的流程信息，可在这里快速查看摘要。"
                else -> "该产物可在电脑端继续查看完整内容。"
            },
            modifier = Modifier.padding(top = 18.dp),
            color = MutedText,
            fontSize = 13.sp,
            lineHeight = 20.sp,
        )
        Button(
            onClick = onOpen,
            enabled = canOpen,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 22.dp),
            colors = ButtonDefaults.buttonColors(containerColor = TgBlue),
        ) {
            Text("打开预览")
        }
    }
}

@Composable
private fun AgentHubLogo(size: androidx.compose.ui.unit.Dp) {
    Image(
        painter = painterResource(R.drawable.ic_agenthub_logo),
        contentDescription = "AgentHub",
        modifier = Modifier
            .size(size)
            .clip(CircleShape),
    )
}

@Composable
private fun SessionAvatar(session: Session) {
    val color = when {
        session.type == "group" -> Color(0xFF5B7FB5)
        session.workspaceAgentId != null -> TgBlue
        else -> WorkAmber
    }
    Box(
        modifier = Modifier
            .size(52.dp)
            .clip(CircleShape)
            .background(color),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = session.title.ifBlank { "A" }.take(1).uppercase(),
            color = Color.White,
            fontWeight = FontWeight.Bold,
            fontSize = 20.sp,
        )
    }
}

private fun contactAvatarColor(contact: AgentContact): Color {
    val hexColor = contact.color.trim()
    if (hexColor.startsWith('#') && hexColor.length == 7) {
        runCatching { return Color(android.graphics.Color.parseColor(hexColor)) }
    }
    // AgentHub-specific Code Agent colors, borrowed from the mobile prototype.
    when (contact.codeAgentType?.trim()?.lowercase()) {
        "claude-code", "claude" -> return Color(0xFFD4A574)
        "codex" -> return Color(0xFF10B981)
        "opencode", "open-code" -> return Color(0xFF60A5FA)
        "gemini", "gemini-cli" -> return Color(0xFFA78BFA)
    }
    // Telegram-style fallback avatar colors (vibrant but not harsh)
    return when (contact.runtimeType) {
        "code-agent" -> Color(0xFF7C5CFF)
        "mcp" -> Color(0xFF7BC862)          // Green
        else -> when (contact.roleType) {
            "orchestrator" -> Color(0xFF6EC9CB)  // Teal
            "reviewer", "verifier" -> Color(0xFF65AADD)  // Blue
            "coder" -> Color(0xFFE8A04D)    // Orange
            "planner" -> Color(0xFFB694E2)  // Purple
            else -> {
                // Hash name to pick a consistent color
                val colors = listOf(
                    Color(0xFFE17076), Color(0xFFE8A04D), Color(0xFF7BC862),
                    Color(0xFF65AADD), Color(0xFF6EC9CB), Color(0xFFB694E2),
                    Color(0xFFEE7AAE),
                )
                val index = (contact.name.hashCode().and(0x7FFFFFFF)) % colors.size
                colors[index]
            }
        }
    }
}

private fun workspaceAgentAvatarColor(agent: WorkspaceAgent): Color {
    val hexColor = agent.color.trim()
    if (hexColor.startsWith('#') && hexColor.length == 7) {
        runCatching { return Color(android.graphics.Color.parseColor(hexColor)) }
    }
    when (agent.codeAgentType?.trim()?.lowercase()) {
        "claude-code", "claude" -> return Color(0xFFD4A574)
        "codex" -> return Color(0xFF10B981)
        "opencode", "open-code" -> return Color(0xFF60A5FA)
        "gemini", "gemini-cli" -> return Color(0xFFA78BFA)
    }
    return when (agent.roleType) {
        "orchestrator" -> Color(0xFFEE5D9A)
        "reviewer", "verifier" -> Color(0xFF65AADD)
        "coder" -> Color(0xFFE8A04D)
        "planner" -> Color(0xFFB694E2)
        else -> Color(0xFF7C5CFF)
    }
}

private fun fallbackAgentAvatarColor(seed: String): Color {
    val colors = listOf(
        Color(0xFF4EA2F6),
        Color(0xFF10B981),
        Color(0xFFD4A574),
        Color(0xFFA78BFA),
        Color(0xFFEE5D9A),
        Color(0xFFE8A04D),
    )
    val index = (seed.ifBlank { "Agent" }.hashCode().and(0x7FFFFFFF)) % colors.size
    return colors[index]
}

private fun workspaceAgentAvatarLabel(agent: WorkspaceAgent): String {
    val avatar = agent.avatar?.trim().orEmpty()
    if (avatar.isNotBlank() && avatar.length <= 4 && !avatar.startsWith("http", ignoreCase = true)) return avatar
    return agent.name.ifBlank { "A" }.take(1).uppercase()
}

private fun userAvatarLabel(profile: MobileUserProfile): String {
    val avatar = profile.avatar?.trim().orEmpty()
    if (avatar.isNotBlank() && avatar.length <= 4 && !avatar.startsWith("http", ignoreCase = true) && !avatar.startsWith("data:", ignoreCase = true)) {
        return avatar
    }
    return profile.name.ifBlank { "Y" }.take(1).uppercase()
}

private fun decodeDataUrlBitmap(value: String): android.graphics.Bitmap? {
    val trimmed = value.trim()
    if (!trimmed.startsWith("data:image/", ignoreCase = true)) return null
    val payload = trimmed.substringAfter(',', missingDelimiterValue = "").takeIf { it.isNotBlank() } ?: return null
    return runCatching {
        val bytes = Base64.decode(payload, Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }.getOrNull()
}

private fun contactAvatarLabel(contact: AgentContact): String {
    val avatar = contact.avatar?.trim().orEmpty()
    if (avatar.isNotBlank() && avatar.length <= 4 && !avatar.startsWith("http", ignoreCase = true)) return avatar
    return contact.name.ifBlank { "A" }.take(1).uppercase()
}

private fun sessionMatchesContact(session: Session, contact: AgentContact): Boolean {
    if (session.workspaceAgentId != null && session.workspaceAgentId == contact.workspaceAgentId) return true
    val savedAgentId = session.metadata?.get("savedAgentId")?.jsonPrimitive?.contentOrNull
    if (!savedAgentId.isNullOrBlank() && savedAgentId == contact.id) return true
    return session.workspaceId == contact.workspaceId &&
        session.title.trim().equals(contact.name.trim(), ignoreCase = true)
}

private fun AgentContact.uniqueKey(): String {
    val runtimeType = this.runtimeType.trim().lowercase()
    val codeAgentType = if (runtimeType == "code-agent") {
        this.codeAgentType?.trim()?.lowercase().orEmpty()
    } else {
        ""
    }
    return when {
        source == "workspace-agent" && !workspaceAgentId.isNullOrBlank() -> "workspace-agent:$workspaceAgentId"
        else -> listOf(name.trim().lowercase(), role.trim().lowercase(), runtimeType, codeAgentType).joinToString("|")
    }
}

@Composable
private fun TopIconButton(label: String, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(40.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(PanelElevated)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (label == "‹") {
            BackGlyph(color = Ink, modifier = Modifier.size(22.dp))
        } else {
            Text(
                text = label,
                color = Ink,
                fontSize = 20.sp,
                fontWeight = FontWeight.Medium,
            )
        }
    }
}

@Composable
private fun BackGlyph(color: Color, modifier: Modifier = Modifier.size(22.dp)) {
    Canvas(modifier = modifier) {
        val stroke = 3.dp.toPx()
        drawLine(
            color = color,
            start = Offset(size.width * 0.62f, size.height * 0.18f),
            end = Offset(size.width * 0.34f, size.height * 0.50f),
            strokeWidth = stroke,
            cap = StrokeCap.Round,
        )
        drawLine(
            color = color,
            start = Offset(size.width * 0.34f, size.height * 0.50f),
            end = Offset(size.width * 0.62f, size.height * 0.82f),
            strokeWidth = stroke,
            cap = StrokeCap.Round,
        )
    }
}

private data class MessageBodySegment(
    val text: String,
    val language: String? = null,
    val isCode: Boolean = false,
)

private enum class MarkdownBlockType {
    Paragraph,
    Heading,
    Bullet,
    Numbered,
    Quote,
    Divider,
    Spacer,
}

private data class MarkdownBlock(
    val type: MarkdownBlockType,
    val text: String = "",
    val level: Int = 0,
    val marker: String = "",
)

private fun splitMessageBody(content: String): List<MessageBodySegment> {
    if (content.isBlank()) return listOf(MessageBodySegment(" "))
    val regex = Regex("""```([^\n`]*)\n?([\s\S]*?)```""")
    val segments = mutableListOf<MessageBodySegment>()
    var lastIndex = 0
    regex.findAll(content).forEach { match ->
        if (match.range.first > lastIndex) {
            segments.add(MessageBodySegment(content.substring(lastIndex, match.range.first)))
        }
        val language = match.groups[1]?.value?.trim()?.takeIf { it.isNotBlank() }
        val code = match.groups[2]?.value?.trimEnd().orEmpty()
        segments.add(MessageBodySegment(text = code, language = language, isCode = true))
        lastIndex = match.range.last + 1
    }
    if (lastIndex < content.length) {
        segments.add(MessageBodySegment(content.substring(lastIndex)))
    }
    return segments.ifEmpty { listOf(MessageBodySegment(content)) }
}

private fun parseMarkdownBlocks(text: String): List<MarkdownBlock> {
    val blocks = mutableListOf<MarkdownBlock>()
    val paragraph = mutableListOf<String>()
    val headingRegex = Regex("""^(#{1,3})\s+(.+)$""")
    val bulletRegex = Regex("""^\s*[-*+]\s+(.+)$""")
    val numberedRegex = Regex("""^\s*(\d+)[.)]\s+(.+)$""")
    val quoteRegex = Regex("""^>\s?(.*)$""")
    val dividerRegex = Regex("""^\s*(?:-{3,}|_{3,}|\*{3,})\s*$""")

    fun flushParagraph() {
        val value = paragraph.joinToString("\n").trim()
        if (value.isNotBlank()) blocks.add(MarkdownBlock(MarkdownBlockType.Paragraph, value))
        paragraph.clear()
    }

    text.replace("\r\n", "\n").split('\n').forEach { rawLine ->
        val line = rawLine.trimEnd()
        val trimmed = line.trim()
        if (trimmed.isBlank()) {
            flushParagraph()
            if (blocks.lastOrNull()?.type != MarkdownBlockType.Spacer) {
                blocks.add(MarkdownBlock(MarkdownBlockType.Spacer))
            }
            return@forEach
        }

        val heading = headingRegex.matchEntire(trimmed)
        val bullet = bulletRegex.matchEntire(line)
        val numbered = numberedRegex.matchEntire(line)
        val quote = quoteRegex.matchEntire(trimmed)

        when {
            dividerRegex.matches(trimmed) -> {
                flushParagraph()
                blocks.add(MarkdownBlock(MarkdownBlockType.Divider))
            }
            heading != null -> {
                flushParagraph()
                blocks.add(
                    MarkdownBlock(
                        type = MarkdownBlockType.Heading,
                        text = heading.groupValues[2].trim(),
                        level = heading.groupValues[1].length,
                    ),
                )
            }
            bullet != null -> {
                flushParagraph()
                blocks.add(MarkdownBlock(MarkdownBlockType.Bullet, bullet.groupValues[1].trim()))
            }
            numbered != null -> {
                flushParagraph()
                blocks.add(
                    MarkdownBlock(
                        type = MarkdownBlockType.Numbered,
                        text = numbered.groupValues[2].trim(),
                        marker = "${numbered.groupValues[1]}.",
                    ),
                )
            }
            quote != null -> {
                flushParagraph()
                blocks.add(MarkdownBlock(MarkdownBlockType.Quote, quote.groupValues[1].trim()))
            }
            else -> paragraph.add(line.trim())
        }
    }

    flushParagraph()
    return blocks
        .dropWhile { it.type == MarkdownBlockType.Spacer }
        .dropLastWhile { it.type == MarkdownBlockType.Spacer }
        .ifEmpty { listOf(MarkdownBlock(MarkdownBlockType.Paragraph, text.trim())) }
}

private fun inlineMarkdown(text: String, textColor: Color): AnnotatedString {
    val tokenRegex = Regex("""(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(?<!\*)\*[^*\n]+\*(?!\*)|(?<!_)_[^_\n]+_(?!_)""")
    return buildAnnotatedString {
        var cursor = 0
        tokenRegex.findAll(text).forEach { match ->
            if (match.range.first > cursor) append(text.substring(cursor, match.range.first))
            val token = match.value
            when {
                token.startsWith("`") && token.endsWith("`") -> withStyle(
                    SpanStyle(
                        color = textColor,
                        background = PanelElevated,
                        fontFamily = FontFamily.Monospace,
                    ),
                ) {
                    append(token.removePrefix("`").removeSuffix("`"))
                }
                (token.startsWith("**") && token.endsWith("**")) ||
                    (token.startsWith("__") && token.endsWith("__")) -> withStyle(
                    SpanStyle(fontWeight = FontWeight.Bold),
                ) {
                    append(token.drop(2).dropLast(2))
                }
                (token.startsWith("*") && token.endsWith("*")) ||
                    (token.startsWith("_") && token.endsWith("_")) -> withStyle(
                    SpanStyle(fontStyle = FontStyle.Italic),
                ) {
                    append(token.drop(1).dropLast(1))
                }
                else -> append(token)
            }
            cursor = match.range.last + 1
        }
        if (cursor < text.length) append(text.substring(cursor))
    }
}

private fun codeAgentRuntimeLabel(runtime: String?): String {
    return when (runtime?.trim()?.lowercase()) {
        "claude-code" -> "Claude Code"
        "codex" -> "Codex CLI"
        "opencode" -> "OpenCode"
        "gemini" -> "Gemini CLI"
        else -> "Code Agent"
    }
}

private fun codeAgentStatusLabel(status: String?, partialSuccess: Boolean): String {
    if (partialSuccess) return "部分成功"
    return when (status?.trim()?.lowercase()) {
        "running" -> "运行中"
        "completed" -> "已完成"
        "failed" -> "失败"
        "cancelled" -> "已取消"
        "timed-out" -> "超时"
        else -> "处理中"
    }
}

private fun codeAgentStatusColor(status: String?, reviewRequired: Boolean): Color {
    if (reviewRequired) return WorkAmber
    return when (status?.trim()?.lowercase()) {
        "completed" -> TgGreen
        "running" -> TgBlue
        "failed", "timed-out" -> Color(0xFFFF6B78)
        "cancelled" -> MutedText
        else -> MutedText
    }
}

private fun formatDuration(durationMs: Long): String {
    return when {
        durationMs < 1_000 -> "${durationMs}ms"
        durationMs < 60_000 -> "${durationMs / 1_000}s"
        else -> "${durationMs / 60_000}m ${(durationMs % 60_000) / 1_000}s"
    }
}

private enum class MobileArtifactKind {
    Web,
    Image,
    Document,
    Diff,
    Workflow,
    File,
}

private data class MobileArtifact(
    val id: String,
    val kind: MobileArtifactKind,
    val title: String,
    val subtitle: String,
    val icon: String,
    val url: String? = null,
    val path: String? = null,
    val source: String? = null,
    val description: String? = null,
)

private fun readArtifacts(
    metadata: JsonObject?,
    streamingCodeAgentRun: JsonObject?,
    workspaceId: String?,
): List<MobileArtifact> {
    val items = mutableListOf<JsonObject>()
    metadata?.get("artifacts")?.asJsonArray()?.forEach { element ->
        (element as? JsonObject)?.let(items::add)
    }
    metadata?.get("codeAgentRun")?.asJsonObject()?.get("artifacts")?.asJsonArray()?.forEach { element ->
        (element as? JsonObject)?.let(items::add)
    }
    streamingCodeAgentRun?.get("artifacts")?.asJsonArray()?.forEach { element ->
        (element as? JsonObject)?.let(items::add)
    }

    return items
        .mapNotNull { artifactFromJson(it, workspaceId) }
        .distinctBy { it.id }
}

private fun artifactFromJson(value: JsonObject, sessionWorkspaceId: String?): MobileArtifact? {
    val id = value.stringValue("id") ?: return null
    val type = value.stringValue("type") ?: return null
    val title = value.stringValue("title")
    val description = value.stringValue("description")

    return when (type) {
        "preview" -> {
            val url = value.stringValue("url")
            MobileArtifact(
                id = id,
                kind = MobileArtifactKind.Web,
                title = title ?: "网页预览",
                subtitle = when (value.stringValue("previewKind")) {
                    "dev-server" -> "开发服务器预览"
                    "static-html" -> "HTML 预览"
                    else -> "网页预览"
                },
                icon = "web",
                url = url,
                description = description,
            )
        }
        "deploy" -> {
            MobileArtifact(
                id = id,
                kind = MobileArtifactKind.Web,
                title = title ?: "部署预览",
                subtitle = listOfNotNull(value.stringValue("provider"), value.stringValue("status"))
                    .joinToString(" · ")
                    .ifBlank { "部署预览" },
                icon = "deploy",
                url = value.stringValue("url"),
                description = description ?: value.stringValue("logs"),
            )
        }
        "file" -> {
            val path = value.stringValue("path") ?: return null
            val ext = path.substringAfterLast('.', "").lowercase()
            val mimeType = value.stringValue("mimeType")
            val workspaceId = value.stringValue("workspaceId") ?: sessionWorkspaceId
            val fileUrl = fileArtifactUrl(path, workspaceId)
            val htmlUrl = if (ext == "html" || ext == "htm") {
                val workspaceQuery = workspaceId?.let { "&workspaceId=${encodeUrl(it)}" }.orEmpty()
                "/api/artifacts/preview-file?path=${encodeUrl(path)}$workspaceQuery"
            } else {
                fileUrl
            }
            val kind = when {
                ext == "html" || ext == "htm" -> MobileArtifactKind.Web
                mimeType?.startsWith("image/") == true || ext in setOf("png", "jpg", "jpeg", "gif", "webp", "svg") -> MobileArtifactKind.Image
                ext in setOf("doc", "docx", "ppt", "pptx", "pdf", "xls", "xlsx") -> MobileArtifactKind.Document
                else -> MobileArtifactKind.File
            }
            MobileArtifact(
                id = id,
                kind = kind,
                title = title ?: path.substringAfterLast('\\').substringAfterLast('/'),
                subtitle = listOfNotNull(mimeType, value.stringValue("status")).joinToString(" · ").ifBlank {
                    when (kind) {
                        MobileArtifactKind.Document -> "文档预览"
                        MobileArtifactKind.Web -> "网页预览"
                        MobileArtifactKind.Image -> "图片预览"
                        else -> "文件产物"
                    }
                },
                icon = when (kind) {
                    MobileArtifactKind.Web -> "web"
                    MobileArtifactKind.Image -> "image"
                    MobileArtifactKind.Document -> if (ext.startsWith("ppt")) "presentation" else "document"
                    else -> "file"
                },
                url = htmlUrl,
                path = path,
                description = description,
            )
        }
        "diff" -> MobileArtifact(
            id = id,
            kind = MobileArtifactKind.Diff,
            title = title ?: value.stringValue("filePath") ?: "代码 Diff",
            subtitle = listOfNotNull(value.stringValue("status"), "Diff").joinToString(" · "),
            icon = "diff",
            path = value.stringValue("filePath"),
            source = value.stringValue("diff"),
            description = description,
        )
        "workflow" -> MobileArtifact(
            id = id,
            kind = MobileArtifactKind.Workflow,
            title = title ?: "工作流",
            subtitle = "Agent 流程",
            icon = "workflow",
            source = value.toString(),
            description = description,
        )
        else -> null
    }
}

private fun JsonObject.stringValue(key: String): String? {
    return (this[key] as? JsonPrimitive)?.contentOrNull
}

private fun JsonObject.booleanValue(key: String): Boolean {
    return when ((this[key] as? JsonPrimitive)?.contentOrNull?.trim()?.lowercase()) {
        "true" -> true
        "false" -> false
        else -> false
    }
}

private fun JsonObject.intValue(key: String): Int? {
    return (this[key] as? JsonPrimitive)?.contentOrNull?.toIntOrNull()
}

private fun JsonObject.longValue(key: String): Long? {
    return (this[key] as? JsonPrimitive)?.contentOrNull?.toLongOrNull()
}

private fun kotlinx.serialization.json.JsonElement.asJsonObject(): JsonObject? {
    return this as? JsonObject
}

private fun kotlinx.serialization.json.JsonElement.asJsonArray(): JsonArray? {
    return runCatching { this.jsonArray }.getOrNull()
}

private fun fileArtifactUrl(path: String, workspaceId: String?): String? {
    val id = workspaceId ?: return null
    return "/api/artifacts/file?path=${encodeUrl(path)}&workspaceId=${encodeUrl(id)}"
}

private fun absoluteArtifactUrl(baseUrl: String?, url: String?): String? {
    if (url.isNullOrBlank()) return null
    if (url.startsWith("http://") || url.startsWith("https://")) return rewriteLocalPreviewUrlForDevice(baseUrl, url)
    val cleanBase = baseUrl?.trim()?.trimEnd('/') ?: return url
    return if (url.startsWith("/")) "$cleanBase$url" else "$cleanBase/$url"
}

private fun rewriteLocalPreviewUrlForDevice(baseUrl: String?, url: String): String {
    val target = runCatching { Uri.parse(url) }.getOrNull() ?: return url
    val targetHost = target.host?.lowercase() ?: return url
    if (targetHost !in setOf("localhost", "127.0.0.1", "0.0.0.0", "::1")) return url
    val base = runCatching { Uri.parse(baseUrl.orEmpty()) }.getOrNull() ?: return url
    val baseHost = base.host?.takeIf { it.isNotBlank() } ?: return url
    if (baseHost.lowercase() in setOf("localhost", "127.0.0.1", "0.0.0.0", "::1")) return url
    val port = target.port
    val authority = if (port > 0) "$baseHost:$port" else baseHost
    return target.buildUpon()
        .scheme(base.scheme ?: target.scheme ?: "http")
        .encodedAuthority(authority)
        .build()
        .toString()
}

private fun encodeUrl(value: String): String {
    return URLEncoder.encode(value, "UTF-8")
}

private fun sessionPreviewText(session: Session): String {
    val content = session.lastMessage?.content
        ?.replace(Regex("\\s+"), " ")
        ?.trim()
        ?.takeIf { it.isNotBlank() }

    if (content != null) {
        return when (session.lastMessage.senderType.trim().lowercase()) {
            "user" -> "我：$content"
            "agent" -> "Agent：$content"
            "system" -> "系统：$content"
            else -> content
        }
    }

    return if (session.type == "group") "暂无群聊消息" else "点击开始对话"
}

private fun formatSessionTime(updatedAt: String?): String {
    if (updatedAt.isNullOrBlank()) return ""
    return try {
        val datePart = updatedAt.substringBefore('T')
        val timePart = updatedAt.substringAfter('T').take(5)
        val today = java.time.LocalDate.now().toString()
        when (datePart) {
            today -> timePart  // Show time for today
            else -> {
                val month = datePart.substring(5, 7).toIntOrNull() ?: 0
                val day = datePart.substring(8, 10).toIntOrNull() ?: 0
                "$month/$day"
            }
        }
    } catch (_: Exception) {
        updatedAt.take(10)
    }
}

private fun senderLabel(message: Message): String {
    return when (message.senderType) {
        "agent" -> "Agent"
        "system" -> "System"
        else -> message.senderType.ifBlank { "AgentHub" }
    }
}
