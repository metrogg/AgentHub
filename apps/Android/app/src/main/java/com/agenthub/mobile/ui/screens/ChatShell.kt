package com.agenthub.mobile.ui.screens

import android.content.Intent
import android.net.Uri
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
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.agenthub.mobile.R
import com.agenthub.mobile.data.Message
import com.agenthub.mobile.data.MobileUiState
import com.agenthub.mobile.data.Session
import com.agenthub.mobile.data.AgentContact
import com.agenthub.mobile.data.Workspace
import com.agenthub.mobile.data.WorkspaceAgent
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.net.URLEncoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonArray

private val Hairline = Color(0xFFE8E8E8)
private val PageBackground = Color(0xFFF5F5F5)
private val PanelBackground = Color.White
private val Ink = Color(0xFF111111)
private val MutedText = Color(0xFF7A7A7A)
private val WeChatGreen = Color(0xFF07C160)
private val SoftFill = Color(0xFFEDEDED)
private val WorkAmber = Color(0xFFF2A23A)
private val ProfileGreenSoft = Color(0xFFEAF8EF)
private val ProfileBlue = Color(0xFF2F80ED)

private enum class MobileTab(val label: String, val icon: String) {
    Messages("聊天", "💬"),
    Agents("Agent", "👥"),
    Workbench("工作台", "⬡"),
    Me("我的", "○"),
}

@OptIn(ExperimentalAnimationApi::class)
@Composable
fun ChatShell(
    state: MobileUiState,
    onDisconnect: () -> Unit,
    onRefresh: () -> Unit,
    onCreateSession: () -> Unit,
    onOpenAgentContact: (AgentContact) -> Unit,
    onSelectSession: (String) -> Unit,
    onSendMessage: (String) -> Unit,
    onArchiveSession: (String) -> Unit,
    onUnarchiveSession: (String) -> Unit,
    onDeleteSession: (String) -> Unit,
    onScanPairingQr: (String) -> Unit,
) {
    var currentTab by remember { mutableStateOf(MobileTab.Messages) }
    var showSessions by remember { mutableStateOf(true) }
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

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(PageBackground),
    ) {
        MobileTopBar(
            title = when {
                currentTab != MobileTab.Messages -> currentTab.label
                showSessions -> "Agent Hub"
                else -> state.selectedSession?.title.orEmpty().ifBlank { "对话" }
            },
            connected = state.connected,
            showBack = currentTab == MobileTab.Messages && !showSessions,
            conversationMode = currentTab == MobileTab.Messages && !showSessions,
            currentSession = state.selectedSession,
            onBack = { showSessions = true },
            onCreateSession = onCreateSession,
            onRefresh = onRefresh,
            onScanQr = ::scanQr,
            onOpenSessions = { showSessions = true },
            onArchiveCurrent = { sessionId ->
                onArchiveSession(sessionId)
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
                    .background(Color(0xFFFFF1F0))
                    .padding(horizontal = 18.dp, vertical = 8.dp),
                color = Color(0xFFB42318),
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
                        onCreateSession = onCreateSession,
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
                    MobileTab.Workbench -> WorkbenchScreen(state = state, onRefresh = onRefresh, onCreateSession = onCreateSession)
                    MobileTab.Me -> ProfileScreen(state = state, onDisconnect = onDisconnect, onScanQr = ::scanQr)
                }
            }
            if (showSessions || currentTab != MobileTab.Messages) {
                MainTabBar(
                    modifier = Modifier.align(Alignment.BottomCenter),
                    active = currentTab,
                    onSelect = { selected ->
                        currentTab = selected
                        if (selected == MobileTab.Messages) showSessions = true
                    },
                )
            }
        }
    }
}

@Composable
private fun MobileTopBar(
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
    onArchiveCurrent: (String) -> Unit,
    onDeleteCurrent: (String) -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .background(PanelBackground)
            .border(width = 0.5.dp, color = Hairline)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (showBack) {
            TopIconButton(label = "‹", onClick = onBack)
            Spacer(modifier = Modifier.width(8.dp))
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(title, color = Ink, fontWeight = FontWeight.Bold, fontSize = 18.sp, maxLines = 1)
            Text(
                if (connected) "电脑端在线" else "离线，可先浏览首页",
                color = if (connected) WeChatGreen else MutedText,
                fontSize = 11.sp,
                maxLines = 1,
            )
        }
        Box(modifier = Modifier.size(40.dp), contentAlignment = Alignment.Center) {
            TopBarActionButton(
                conversationMode = conversationMode,
                onClick = { menuOpen = true },
            )
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                if (conversationMode) {
                    DropdownMenuItem(text = { Text("会话设置") }, onClick = {
                        menuOpen = false
                    })
                    DropdownMenuItem(text = { Text("回到会话列表") }, onClick = {
                        menuOpen = false
                        onOpenSessions()
                    })
                    DropdownMenuItem(text = { Text("归档会话") }, onClick = {
                        menuOpen = false
                        currentSession?.id?.let(onArchiveCurrent)
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
}

@Composable
private fun TopBarActionButton(conversationMode: Boolean, onClick: () -> Unit) {
    val background = if (conversationMode) SoftFill else Color(0xFF2C2C2C)
    val foreground = if (conversationMode) Ink else Color.White
    Box(
        modifier = Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(background)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (conversationMode) {
            MoreGlyph(color = foreground)
        } else {
            PlusGlyph(color = foreground)
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

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "搜索",
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(8.dp))
                    .background(SoftFill)
                    .padding(horizontal = 14.dp, vertical = 9.dp),
                color = MutedText,
                fontSize = 14.sp,
            )
            Spacer(modifier = Modifier.width(10.dp))
            Text(
                text = if (showArchived) "归档" else "当前",
                modifier = Modifier
                    .clip(RoundedCornerShape(999.dp))
                    .background(if (showArchived) Color(0xFFEAF3DD) else SoftFill)
                    .clickable { showArchived = !showArchived }
                    .padding(horizontal = 13.dp, vertical = 9.dp),
                color = if (showArchived) WeChatGreen else Ink,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
            )
        }

        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(bottom = 84.dp),
        ) {
            item { SectionTitle(if (showArchived) "已归档会话" else "最近消息") }
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

@Composable
private fun EmptySessionList(archived: Boolean, onCreateSession: () -> Unit, onRefresh: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 28.dp, vertical = 42.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        AgentHubLogo(size = 58.dp)
        Text(
            if (archived) "暂无归档会话" else "还没有Agent联系人",
            modifier = Modifier.padding(top = 16.dp),
            color = Ink,
            fontWeight = FontWeight.Bold,
            fontSize = 20.sp,
        )
        Text(
            if (archived) "删除前可以先把不常用会话收进这里。" else "同步电脑端，点右上角 + 扫一扫。",
            modifier = Modifier.padding(top = 8.dp),
            color = MutedText,
            fontSize = 14.sp,
            lineHeight = 21.sp,
        )
        Row(modifier = Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(onClick = onCreateSession, colors = ButtonDefaults.buttonColors(containerColor = Ink)) {
                Text("新建")
            }
            OutlinedButton(onClick = onRefresh) {
                Text("同步")
            }
        }
    }
}

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

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(if (selected) Color(0xFFEAF3DD) else PanelBackground)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SessionAvatar(session)
        Spacer(modifier = Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = session.title.ifBlank { "未命名会话" },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    fontWeight = FontWeight.SemiBold,
                    color = Ink,
                    modifier = Modifier.weight(1f),
                )
                Text("刚刚", color = MutedText, fontSize = 11.sp)
            }
            Text(
                text = if (session.type == "group") "Agent 群聊" else "Agent 单聊",
                modifier = Modifier.padding(top = 5.dp),
                color = MutedText,
                fontSize = 13.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Box {
            Text(
                text = "⋯",
                modifier = Modifier
                    .size(34.dp)
                    .clip(CircleShape)
                    .clickable { menuOpen = true }
                    .padding(start = 8.dp, bottom = 7.dp),
                color = MutedText,
                fontSize = 24.sp,
            )
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
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(PanelBackground)
            .border(0.5.dp, Hairline)
            .navigationBarsPadding()
            .padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.SpaceAround,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MobileTab.values().forEach { tab ->
            TabItem(tab = tab, active = active == tab, onClick = { onSelect(tab) })
        }
    }
}

@Composable
private fun TabItem(tab: MobileTab, active: Boolean, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .clip(RoundedCornerShape(10.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 2.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        TabIcon(tab = tab, active = active)
        Text(
            text = tab.label,
            modifier = Modifier.padding(top = 1.dp),
            color = if (active) WeChatGreen else MutedText,
            fontSize = 10.sp,
            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        )
    }
}

@Composable
private fun TabIcon(tab: MobileTab, active: Boolean) {
    when (tab) {
        MobileTab.Messages -> {
            Image(
                painter = painterResource(R.drawable.ic_agenthub),
                contentDescription = null,
                modifier = Modifier
                    .size(21.dp)
                    .alpha(if (active) 1f else 0.72f),
            )
        }
        else -> {
            Text(
                text = tab.icon,
                color = if (active) WeChatGreen else MutedText,
                fontSize = 17.sp,
            )
        }
    }
}

@Composable
private fun ConversationScreen(
    state: MobileUiState,
    onOpenSessions: () -> Unit,
    onSendMessage: (String) -> Unit,
) {
    var input by remember(state.selectedSessionId) { mutableStateOf("") }
    var previewArtifact by remember { mutableStateOf<MobileArtifact?>(null) }
    val messages = state.messages + listOfNotNull(state.streamingMessage)
    val showHome = messages.isEmpty() && !state.agentTyping

    Box(modifier = Modifier.fillMaxSize()) {
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
                    .padding(horizontal = 30.dp),
            )
        } else {
            val streamingId = state.streamingMessage?.id
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(bottom = 118.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item { Spacer(modifier = Modifier.height(12.dp)) }
                items(messages, key = { it.id }) { message ->
                    MessageBubble(
                        message = message,
                        streaming = message.id == streamingId,
                        streamingCodeAgentRun = if (message.id == streamingId) state.streamingCodeAgentRun else null,
                        baseUrl = state.connection?.baseUrl,
                        workspaceId = state.selectedSession?.workspaceId,
                        onPreviewArtifact = { previewArtifact = it },
                    )
                }
                if (state.agentTyping && state.streamingMessage == null) {
                    item {
                        TypingIndicator()
                    }
                }
                item { Spacer(modifier = Modifier.height(18.dp)) }
            }
        }

        MobileChatComposer(
            value = input,
            onValueChange = { input = it },
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

        previewArtifact?.let { artifact ->
            ArtifactPreviewOverlay(
                artifact = artifact,
                baseUrl = state.connection?.baseUrl,
                onClose = { previewArtifact = null },
            )
        }
    }
}

@Composable
private fun MobileHomeContent(modifier: Modifier) {
    Column(modifier = modifier) {
        Spacer(modifier = Modifier.weight(1f))
        Text(
            text = "有什么可以帮忙的？",
            color = Ink,
            fontSize = 27.sp,
            lineHeight = 34.sp,
            fontWeight = FontWeight.Bold,
        )
        Spacer(modifier = Modifier.weight(1.6f))
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
                workspacesById[it.workspaceId]?.name.orEmpty()
            }.thenBy { it.name }.thenBy { it.role },
        )
    }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            FeatureHero(
                title = "Agent 通讯录",
                subtitle = if (state.connected) {
                    "已同步 ${contacts.size} 个唯一联系人，点击即可打开对应私聊。"
                } else {
                    "连接电脑端后会自动同步电脑端的 Agent 通讯录。"
                },
                icon = "👥",
                action = "同步通讯录",
                onAction = onRefresh,
            )
        }
        if (contacts.isEmpty()) {
            item {
                EmptyAgentDirectory(onRefresh = onRefresh)
            }
        } else {
            item { SectionTitle("Agent") }
            items(contacts, key = { it.uniqueKey() }) { contact ->
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

@Composable
private fun EmptyAgentDirectory(onRefresh: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(PanelBackground)
            .padding(horizontal = 18.dp, vertical = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        AgentHubLogo(size = 52.dp)
        Text(
            "暂无 Agent",
            modifier = Modifier.padding(top = 14.dp),
            color = Ink,
            fontWeight = FontWeight.Bold,
            fontSize = 18.sp,
        )
        Text(
            "请先在电脑端创建工作区或 Agent，然后点击同步到手机端。",
            modifier = Modifier.padding(top = 8.dp),
            color = MutedText,
            fontSize = 13.sp,
            lineHeight = 20.sp,
        )
        OutlinedButton(
            onClick = onRefresh,
            modifier = Modifier.padding(top = 16.dp),
        ) {
            Text("同步")
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
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(PanelBackground)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(46.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(contactAvatarColor(contact)),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                contactAvatarLabel(contact),
                color = Color.White,
                fontWeight = FontWeight.Bold,
                fontSize = 16.sp,
            )
        }
        Spacer(modifier = Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                contact.name.ifBlank { "Agent" },
                color = Ink,
                fontWeight = FontWeight.SemiBold,
                fontSize = 16.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                listOfNotNull(
                    workspace?.name?.takeIf { it.isNotBlank() },
                    contact.role.takeIf { it.isNotBlank() } ?: contact.roleType,
                ).joinToString(" · "),
                modifier = Modifier.padding(top = 4.dp),
                color = MutedText,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (contact.description.isNotBlank()) {
                Text(
                    contact.description,
                    modifier = Modifier.padding(top = 3.dp),
                    color = Color(0xFF666666),
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Text(
            if (hasSession) "继续" else "打开",
            color = WeChatGreen,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun WorkbenchScreen(state: MobileUiState, onRefresh: () -> Unit, onCreateSession: () -> Unit) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            FeatureHero(
                title = "移动工作台",
                subtitle = "移植桌面端的运行历史、执行日志、模型、Coding Tools、Skills 和办公室入口，手机端先做轻量查看与触发。",
                icon = "⬡",
                action = "同步",
                onAction = onRefresh,
            )
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                MetricCard("会话", state.sessions.size.toString(), Modifier.weight(1f))
                MetricCard("在线", if (state.connected) "1" else "0", Modifier.weight(1f))
                MetricCard("流式", if (state.streamingMessage != null) "ON" else "OFF", Modifier.weight(1f))
            }
        }
        items(
            listOf("运行历史", "执行日志", "模型管理", "Coding Tools", "Skills 市场", "办公室"),
        ) { title ->
            QuickEntry(title, "桌面端功能的移动入口", "›", onRefresh)
        }
        item {
            QuickEntry("新任务", "发给电脑端执行", "+", onCreateSession)
            Spacer(modifier = Modifier.height(84.dp))
        }
    }
}

@Composable
private fun ProfileScreen(state: MobileUiState, onDisconnect: () -> Unit, onScanQr: () -> Unit) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFFF7F8FA))
            .padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { Spacer(modifier = Modifier.height(6.dp)) }
        item {
            ProfileHeroCard(
                connected = state.connected,
                baseUrl = state.connection?.baseUrl ?: "未连接电脑端",
            )
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ProfileMetricTile(
                    label = "会话",
                    value = state.sessions.size.toString(),
                    modifier = Modifier.weight(1f),
                )
                ProfileMetricTile(
                    label = "连接",
                    value = if (state.connected) "在线" else "离线",
                    modifier = Modifier.weight(1f),
                    accent = if (state.connected) WeChatGreen else MutedText,
                )
                ProfileMetricTile(
                    label = "流式",
                    value = if (state.streamingMessage != null) "ON" else "OFF",
                    modifier = Modifier.weight(1f),
                    accent = if (state.streamingMessage != null) ProfileBlue else MutedText,
                )
            }
        }
        item {
            ProfileInfoCard(
                rows = listOf(
                    "设备名" to (state.connection?.deviceName ?: "Android"),
                    "连接状态" to if (state.connected) "电脑端在线" else "未连接",
                    "服务地址" to (state.connection?.baseUrl ?: "等待扫码配对"),
                ),
            )
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                ProfilePrimaryAction(
                    text = "扫码连接电脑端",
                    onClick = onScanQr,
                )
                ProfileSecondaryAction(
                    text = "断开电脑端",
                    enabled = state.connection != null,
                    onClick = onDisconnect,
                )
            }
        }
        item {
            Text(
                text = if (state.connected) "手机端会跟随电脑端实时同步会话、消息和 Agent 状态。" else "打开电脑端设置里的移动端连接，扫码后即可同步。",
                color = MutedText,
                fontSize = 12.sp,
                lineHeight = 18.sp,
                modifier = Modifier.padding(start = 2.dp, top = 2.dp, end = 2.dp),
            )
        }
        item { Spacer(modifier = Modifier.height(92.dp)) }
    }
}

@Composable
private fun FeatureHero(title: String, subtitle: String, icon: String, action: String, onAction: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(PanelBackground)
            .padding(18.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(icon, fontSize = 24.sp, color = Ink)
            Spacer(modifier = Modifier.width(12.dp))
            Text(title, color = Ink, fontWeight = FontWeight.Bold, fontSize = 20.sp)
        }
        Text(subtitle, modifier = Modifier.padding(top = 10.dp), color = MutedText, fontSize = 14.sp, lineHeight = 21.sp)
        Button(
            onClick = onAction,
            modifier = Modifier.padding(top = 14.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Ink),
        ) {
            Text(action)
        }
    }
}

@Composable
private fun MetricCard(label: String, value: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(PanelBackground)
            .padding(14.dp),
    ) {
        Text(value, color = Ink, fontWeight = FontWeight.Bold, fontSize = 20.sp)
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
            .clip(RoundedCornerShape(22.dp))
            .background(PanelBackground)
            .border(0.5.dp, Hairline, RoundedCornerShape(22.dp))
            .padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box {
                AgentHubLogo(size = 58.dp)
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .size(16.dp)
                        .clip(CircleShape)
                        .background(if (connected) WeChatGreen else MutedText)
                        .border(2.dp, PanelBackground, CircleShape),
                )
            }
            Spacer(modifier = Modifier.width(14.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text("AgentHub Mobile", color = Ink, fontWeight = FontWeight.Bold, fontSize = 22.sp, maxLines = 1)
                Text(
                    baseUrl,
                    modifier = Modifier.padding(top = 2.dp),
                    color = MutedText,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Row(
            modifier = Modifier
                .padding(top = 16.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(if (connected) ProfileGreenSoft else SoftFill)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(if (connected) WeChatGreen else MutedText),
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text(
                if (connected) "电脑端在线，移动端已接入" else "等待扫码连接电脑端",
                color = if (connected) Color(0xFF14783C) else MutedText,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
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
            .background(WeChatGreen)
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
            .background(if (enabled) PanelBackground else Color(0xFFF0F0F0))
            .border(0.8.dp, if (enabled) Hairline else Color(0xFFE0E0E0), RoundedCornerShape(16.dp))
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
    onSend: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val canSend = value.trim().isNotEmpty()

    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(PanelBackground)
            .border(0.5.dp, Hairline)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        ComposerRoundButton(label = "+", onClick = {})
        Box(
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = 8.dp)
                .clip(RoundedCornerShape(18.dp))
                .background(SoftFill)
                .padding(horizontal = 12.dp, vertical = 9.dp),
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 24.dp, max = 92.dp),
                textStyle = TextStyle(color = Ink, fontSize = 16.sp, lineHeight = 22.sp),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { if (canSend) onSend() }),
                decorationBox = { innerTextField ->
                    Box {
                        if (value.isBlank()) {
                            Text("发消息给 AgentHub", color = MutedText, fontSize = 15.sp)
                        }
                        innerTextField()
                    }
                },
            )
        }
        ComposerRoundButton(label = "@", onClick = {})
        Spacer(modifier = Modifier.width(8.dp))
        Box(
            modifier = Modifier
                .size(38.dp)
                .clip(CircleShape)
                .background(if (canSend) WeChatGreen else Color(0xFFE5E5E5))
                .clickable(enabled = canSend, onClick = onSend),
            contentAlignment = Alignment.Center,
        ) {
            Text("↑", color = Color.White, fontSize = 19.sp, fontWeight = FontWeight.Bold)
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
                    .background(if (value.isBlank()) Color(0xFFE8E8E5) else WeChatGreen)
                    .clickable(enabled = value.isNotBlank(), onClick = onSend),
                contentAlignment = Alignment.Center,
            ) {
                Text("↑", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
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
    onPreviewArtifact: (MobileArtifact) -> Unit,
) {
    val isUser = message.senderType == "user"
    val artifacts = remember(message.metadata, streamingCodeAgentRun, workspaceId) {
        readArtifacts(message.metadata, streamingCodeAgentRun, workspaceId)
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 18.dp),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth(0.86f)
                .clip(RoundedCornerShape(12.dp))
                .background(if (isUser) Color(0xFF95EC69) else PanelBackground)
                .border(
                    width = if (streaming && !isUser) 1.dp else 0.dp,
                    color = if (streaming && !isUser) WeChatGreen.copy(alpha = 0.45f) else Color.Transparent,
                    shape = RoundedCornerShape(12.dp),
                )
                .padding(14.dp),
        ) {
            Text(
                text = if (isUser) "我" else senderLabel(message),
                color = MutedText,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = message.content.ifBlank { " " },
                modifier = Modifier.padding(top = 6.dp),
                color = Ink,
                lineHeight = 20.sp,
            )
            if (streaming && !isUser) {
                StreamingStatusBar(
                    text = if (artifacts.isEmpty()) "正在实时输出" else "正在生成产物，可快速预览",
                )
            }
            if (artifacts.isNotEmpty()) {
                ArtifactStrip(artifacts = artifacts, onPreview = onPreviewArtifact)
            }
        }
    }
}

@Composable
private fun StreamingStatusBar(text: String) {
    Row(
        modifier = Modifier
            .padding(top = 10.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(Color(0xFFEAF3DD))
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(7.dp)
                .clip(CircleShape)
                .background(WeChatGreen),
        )
        Spacer(modifier = Modifier.width(6.dp))
        Text(text, color = WeChatGreen, fontSize = 12.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun TypingIndicator() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 18.dp),
        horizontalArrangement = Arrangement.Start,
    ) {
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(12.dp))
                .background(PanelBackground)
                .padding(horizontal = 14.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(WeChatGreen),
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text("Agent 正在思考...", color = MutedText, fontSize = 13.sp)
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
            .background(Color(0xFFF6F6F6))
            .clickable(onClick = onClick)
            .padding(horizontal = 11.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(artifact.icon, fontSize = 18.sp)
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
        Text("预览", color = WeChatGreen, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun ArtifactPreviewOverlay(
    artifact: MobileArtifact,
    baseUrl: String?,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val absoluteUrl = remember(artifact.url, baseUrl) { absoluteArtifactUrl(baseUrl, artifact.url) }

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
                color = if (absoluteUrl != null) WeChatGreen else MutedText,
                fontSize = 14.sp,
            )
        }

        when {
            artifact.kind == MobileArtifactKind.Web && absoluteUrl != null -> {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { viewContext ->
                        WebView(viewContext).apply {
                            webViewClient = WebViewClient()
                            settings.javaScriptEnabled = true
                            settings.domStorageEnabled = true
                            loadUrl(absoluteUrl)
                        }
                    },
                    update = { webView ->
                        if (webView.url != absoluteUrl) webView.loadUrl(absoluteUrl)
                    },
                )
            }
            artifact.kind == MobileArtifactKind.Image && absoluteUrl != null -> {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { viewContext ->
                        WebView(viewContext).apply {
                            webViewClient = WebViewClient()
                            loadUrl(absoluteUrl)
                        }
                    },
                    update = { webView ->
                        if (webView.url != absoluteUrl) webView.loadUrl(absoluteUrl)
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
        Text(artifact.icon, fontSize = 52.sp)
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
            colors = ButtonDefaults.buttonColors(containerColor = WeChatGreen),
        ) {
            Text("打开预览")
        }
    }
}

@Composable
private fun AgentHubLogo(size: androidx.compose.ui.unit.Dp) {
    Image(
        painter = painterResource(R.drawable.ic_agenthub),
        contentDescription = "AgentHub",
        modifier = Modifier
            .size(size)
            .clip(RoundedCornerShape(size / 3)),
    )
}

@Composable
private fun SessionAvatar(session: Session) {
    val color = when {
        session.type == "group" -> Ink
        session.workspaceAgentId != null -> WeChatGreen
        else -> WorkAmber
    }
    Box(
        modifier = Modifier
            .size(46.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(color),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = session.title.ifBlank { "A" }.take(1).uppercase(),
            color = Color.White,
            fontWeight = FontWeight.Bold,
            fontSize = 17.sp,
        )
    }
}

private fun contactAvatarColor(contact: AgentContact): Color {
    val hexColor = contact.color.trim()
    if (hexColor.startsWith('#') && hexColor.length == 7) {
        runCatching { return Color(android.graphics.Color.parseColor(hexColor)) }
    }
    return when (contact.runtimeType) {
        "code-agent" -> WorkAmber
        "mcp" -> Color(0xFF576B95)
        else -> when (contact.roleType) {
            "orchestrator" -> Ink
            "reviewer", "verifier" -> Color(0xFF576B95)
            "coder" -> WorkAmber
            else -> WeChatGreen
        }
    }
}

private fun contactAvatarLabel(contact: AgentContact): String {
    val avatar = contact.avatar?.trim().orEmpty()
    if (avatar.isNotBlank() && avatar.length <= 4 && !avatar.startsWith("http", ignoreCase = true)) return avatar
    return contact.name.ifBlank { "A" }.take(1).uppercase()
}

private fun agentToContact(agent: WorkspaceAgent): AgentContact? {
    return AgentContact(
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

private fun sessionMatchesContact(session: Session, contact: AgentContact): Boolean {
    if (session.workspaceAgentId != null && session.workspaceAgentId == contact.workspaceAgentId) return true
    val savedAgentId = session.metadata?.get("savedAgentId")?.jsonPrimitive?.contentOrNull
    if (!savedAgentId.isNullOrBlank() && savedAgentId == contact.id) return true
    return session.workspaceId == contact.workspaceId &&
        session.title.trim().equals(contact.name.trim(), ignoreCase = true)
}

private fun AgentContact.uniqueKey(): String {
    return when {
        source == "workspace-agent" && !workspaceAgentId.isNullOrBlank() -> "workspace-agent:$workspaceAgentId"
        else -> listOf(name.trim().lowercase(), role.trim().lowercase(), runtimeType.trim().lowercase(), codeAgentType?.trim()?.lowercase().orEmpty()).joinToString("|")
    }
}

@Composable
private fun TopIconButton(label: String, onClick: () -> Unit) {
    Text(
        text = label,
        modifier = Modifier
            .size(34.dp)
            .clip(RoundedCornerShape(10.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 2.dp),
        color = Ink,
        fontSize = 28.sp,
        fontWeight = FontWeight.Medium,
    )
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text = text,
        modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
        color = MutedText,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
    )
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
                icon = "🌐",
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
                icon = "🚀",
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
                    MobileArtifactKind.Web -> "🌐"
                    MobileArtifactKind.Image -> "🖼"
                    MobileArtifactKind.Document -> if (ext.startsWith("ppt")) "📊" else "📄"
                    else -> "📎"
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
            icon = "⌘",
            path = value.stringValue("filePath"),
            source = value.stringValue("diff"),
            description = description,
        )
        "workflow" -> MobileArtifact(
            id = id,
            kind = MobileArtifactKind.Workflow,
            title = title ?: "工作流",
            subtitle = "Agent 流程",
            icon = "⬡",
            source = value.toString(),
            description = description,
        )
        else -> null
    }
}

private fun JsonObject.stringValue(key: String): String? {
    return (this[key] as? JsonPrimitive)?.contentOrNull
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
    if (url.startsWith("http://") || url.startsWith("https://")) return url
    val cleanBase = baseUrl?.trim()?.trimEnd('/') ?: return url
    return if (url.startsWith("/")) "$cleanBase$url" else "$cleanBase/$url"
}

private fun encodeUrl(value: String): String {
    return URLEncoder.encode(value, "UTF-8")
}

private fun senderLabel(message: Message): String {
    return when (message.senderType) {
        "agent" -> "Agent"
        "system" -> "System"
        else -> message.senderType.ifBlank { "AgentHub" }
    }
}
