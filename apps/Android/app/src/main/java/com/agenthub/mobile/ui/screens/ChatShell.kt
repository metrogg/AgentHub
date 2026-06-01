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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
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
import com.agenthub.mobile.data.MobileWorkbenchCodingToolItem
import com.agenthub.mobile.data.MobileWorkbenchRunSummary
import com.agenthub.mobile.data.MobileWorkbenchSkillSummary
import com.agenthub.mobile.data.MobileWorkbenchWorkspaceSummary
import com.agenthub.mobile.data.TestModelRequest
import com.agenthub.mobile.data.Workspace
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.net.URLEncoder
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
}

@OptIn(ExperimentalAnimationApi::class)
@Composable
fun ChatShell(
    state: MobileUiState,
    onDisconnect: () -> Unit,
    onRefresh: () -> Unit,
    onCreateSession: () -> Unit,
    onOpenWorkspaceGroupSession: (String) -> Unit,
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
    var workbenchSubScreen by remember { mutableStateOf<String?>(null) }
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
                currentTab == MobileTab.Workbench && workbenchSubScreen != null -> when (workbenchSubScreen) {
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
                (currentTab == MobileTab.Workbench && workbenchSubScreen != null),
            conversationMode = currentTab == MobileTab.Messages && !showSessions,
            currentSession = state.selectedSession,
            onBack = {
                if (currentTab == MobileTab.Workbench && workbenchSubScreen != null) {
                    workbenchSubScreen = null
                } else {
                    showSessions = true
                }
            },
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
                    MobileTab.Workbench -> {
                        val subScreen = workbenchSubScreen
                        when (subScreen) {
                            "model-management" -> ModelManagementScreen(
                                state = state,
                                onBack = { workbenchSubScreen = null },
                                onFetchSettings = onFetchSettings,
                                onUpdateSettings = onUpdateSettings,
                                onTestModel = onTestModel,
                                onClearTestResult = onClearTestModelResult,
                                onRefresh = onRefresh,
                            )
                            "coding-tools" -> CodingToolsScreen(
                                state = state,
                                onBack = { workbenchSubScreen = null },
                                onInstall = onInstallCodingTools,
                                onRepair = onRepairCodingTools,
                                onRefresh = onRefresh,
                            )
                            "skills-market" -> SkillsMarketScreen(
                                state = state,
                                onBack = { workbenchSubScreen = null },
                                onRefresh = onRefresh,
                            )
                            "office" -> OfficeScreen(
                                state = state,
                                onBack = { workbenchSubScreen = null },
                                onStartOffice = onStartOffice,
                                onOpenFirewall = onOpenFirewall,
                                onRefresh = onRefresh,
                            )
                            else -> WorkbenchScreenV2(
                                state = state,
                                onRefresh = onRefresh,
                                onCreateSession = onCreateSession,
                                onOpenWorkspaceGroupSession = onOpenWorkspaceGroupSession,
                                onStartOffice = onStartOffice,
                                onOpenFirewall = onOpenFirewall,
                                onInstallCodingTools = onInstallCodingTools,
                                onRepairCodingTools = onRepairCodingTools,
                                onOpenModelManagement = { workbenchSubScreen = "model-management" },
                                onOpenCodingTools = { workbenchSubScreen = "coding-tools" },
                                onOpenSkillsMarket = { workbenchSubScreen = "skills-market" },
                                onOpenOffice = { workbenchSubScreen = "office" },
                            )
                        }
                    }
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
                        workbenchSubScreen = null
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
    var showSettings by remember { mutableStateOf(false) }
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
            session = currentSession,
            connected = connected,
            onDismiss = { showSettings = false },
            onRefresh = {
                showSettings = false
                onRefresh()
            },
            onArchive = {
                showSettings = false
                onArchiveCurrent(currentSession.id)
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
    session: Session,
    connected: Boolean,
    onDismiss: () -> Unit,
    onRefresh: () -> Unit,
    onArchive: () -> Unit,
    onRequestDelete: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = PanelBackground,
        title = { Text("会话设置", color = Ink, fontWeight = FontWeight.SemiBold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SettingsInfoRow("名称", session.title.ifBlank { "未命名会话" })
                SettingsInfoRow("类型", if (session.type == "group") "群聊" else "私聊")
                SettingsInfoRow("同步", if (connected) "已同步到电脑端" else "等待连接")
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    TextButton(onClick = onArchive) {
                        Text("归档", color = TgBlue)
                    }
                    TextButton(onClick = onRequestDelete) {
                        Text("删除", color = Color(0xFFFF6B78))
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onRefresh) {
                Text("同步", color = TgBlue)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("关闭", color = MutedText)
            }
        },
    )
}

@Composable
private fun SettingsInfoRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = MutedText, fontSize = 13.sp, modifier = Modifier.width(54.dp))
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
            FloatingTelegramActionButton(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(end = 18.dp, bottom = 88.dp),
                onClick = onCreateSession,
            )
        }
    }
}

@Composable
private fun FloatingTelegramActionButton(modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(
        modifier = modifier
            .size(58.dp)
            .clip(CircleShape)
            .background(TgBlue)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        PlusGlyph(color = Color.White, modifier = Modifier.size(24.dp))
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
    // Simulated last message and unread count for display
    val lastMessage = remember(session) {
        when {
            session.type == "group" -> "群聊消息"
            else -> "点击开始对话"
        }
    }
    val sessionTime = remember(session) { formatSessionTime(session.updatedAt) }
    val unreadCount = remember(session) { 0 } // TODO: wire from real unread data

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(if (selected) PanelElevated else PanelBackground)
            .border(if (selected) 0.5.dp else 0.dp, TgBlue, RoundedCornerShape(0.dp))
            .combinedClickable(
                onClick = onClick,
                onLongClick = { menuOpen = true },
            )
            .padding(horizontal = 16.dp, vertical = 12.dp),
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
    val messages = state.messages + listOfNotNull(state.streamingMessage)
    val showHome = messages.isEmpty() && !state.agentTyping

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
                    .padding(horizontal = 30.dp),
            )
        } else {
            val streamingId = state.streamingMessage?.id
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(bottom = 120.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                item { Spacer(modifier = Modifier.height(8.dp)) }
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
private fun WorkbenchScreen(state: MobileUiState, onRefresh: () -> Unit, onCreateSession: () -> Unit) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .background(SoftFill),
    ) {
        // Stats cards
        item {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(PanelBackground)
                    .padding(horizontal = 16.dp, vertical = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                MetricCard("会话", state.sessions.size.toString(), Modifier.weight(1f))
                MetricCard("在线", if (state.connected) "✓" else "—", Modifier.weight(1f))
                MetricCard("Agent", state.contacts.size.toString(), Modifier.weight(1f))
            }
        }

        item {
            Spacer(modifier = Modifier.fillMaxWidth().height(24.dp).background(SoftFill))
        }

        // Quick entries (Telegram-style settings list)
        item {
            Column(modifier = Modifier.background(PanelBackground)) {
                WorkbenchMenuEntry(title = "运行历史", icon = LineIconKind.History, onClick = onRefresh)
                WorkbenchMenuDivider()
                WorkbenchMenuEntry(title = "执行日志", icon = LineIconKind.Logs, onClick = onRefresh)
                WorkbenchMenuDivider()
                WorkbenchMenuEntry(title = "模型管理", icon = LineIconKind.Bot, onClick = onRefresh)
                WorkbenchMenuDivider()
                WorkbenchMenuEntry(title = "Coding Tools", icon = LineIconKind.Tools, onClick = onRefresh)
                WorkbenchMenuDivider()
                WorkbenchMenuEntry(title = "Skills 市场", icon = LineIconKind.Skills, onClick = onRefresh)
                WorkbenchMenuDivider()
                WorkbenchMenuEntry(title = "办公室", icon = LineIconKind.Office, onClick = onRefresh)
            }
        }

        item {
            Spacer(modifier = Modifier.fillMaxWidth().height(24.dp).background(SoftFill))
        }

        // New task button
        item {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(PanelBackground)
                    .clickable(onClick = onCreateSession)
                    .padding(horizontal = 16.dp, vertical = 14.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    PlusGlyph(color = TgBlue, modifier = Modifier.size(16.dp))
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("新任务", color = TgBlue, fontSize = 15.sp)
                }
            }
        }

        item { Spacer(modifier = Modifier.height(92.dp)) }
    }
}

@Composable
private fun WorkbenchMenuEntry(title: String, icon: LineIconKind, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(30.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(TgBlueLight),
            contentAlignment = Alignment.Center,
        ) {
            LineIcon(kind = icon, color = TgBlue, modifier = Modifier.size(18.dp))
        }
        Spacer(modifier = Modifier.width(14.dp))
        Text(title, color = Ink, fontSize = 15.sp, modifier = Modifier.weight(1f))
        Text("›", color = MutedText, fontSize = 18.sp)
    }
}

@Composable
private fun WorkbenchMenuDivider() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 50.dp)
            .height(0.5.dp)
            .background(Hairline),
    )
}

@Composable
private fun WorkbenchScreenV2(
    state: MobileUiState,
    onRefresh: () -> Unit,
    onCreateSession: () -> Unit,
    onOpenWorkspaceGroupSession: (String) -> Unit,
    onStartOffice: () -> Unit,
    onOpenFirewall: () -> Unit,
    onInstallCodingTools: () -> Unit,
    onRepairCodingTools: () -> Unit,
    onOpenModelManagement: () -> Unit,
    onOpenCodingTools: () -> Unit,
    onOpenSkillsMarket: () -> Unit,
    onOpenOffice: () -> Unit,
) {
    val workbench = state.workbench
    val workspaceItems = workbench?.workspaces ?: fallbackWorkbenchWorkspaces(state)
    val runItems = workbench?.runs.orEmpty()
    val toolItems = workbench?.codingTools?.items.orEmpty()
    val skills = workbench?.skills.orEmpty()
    val activeRuns = runItems.count { it.status in setOf("planning", "running", "synthesizing") }
    val readyTools = toolItems.count { it.ready }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            FeatureHero(
                title = "移动工作台",
                subtitle = if (state.connected) {
                    "桌面端的工作区、运行历史、Coding Tools、Skills、模型和办公室状态都已同步到手机。"
                } else {
                    "连接电脑端后，工作台会同步全部桌面功能入口。"
                },
                icon = "WB",
                action = if (state.workbenchLoading) "同步中" else "同步",
                onAction = onRefresh,
            )
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                MetricCard("工作区", workspaceItems.size.toString(), Modifier.weight(1f))
                MetricCard("运行中", activeRuns.toString(), Modifier.weight(1f))
                MetricCard("就绪工具", "$readyTools/${toolItems.size.coerceAtLeast(1)}", Modifier.weight(1f))
            }
        }
        item { WorkbenchSectionHeader("工作区", "群聊、Agent、任务与项目路径") }
        if (workspaceItems.isEmpty()) {
            item { WorkbenchEmptyCard("暂无工作区", "在电脑端创建工作区后，这里会自动出现。") }
        } else {
            items(workspaceItems.take(8), key = { it.id }) { workspace ->
                WorkspaceSummaryCard(
                    workspace = workspace,
                    onOpenGroup = { onOpenWorkspaceGroupSession(workspace.id) },
                )
            }
        }
        item { WorkbenchSectionHeader("运行历史", "Orchestrator 与任务调度状态") }
        if (runItems.isEmpty()) {
            item { WorkbenchEmptyCard("暂无运行记录", "从群聊触发 @orchestrator 后，这里会展示最近运行。") }
        } else {
            items(runItems.take(5), key = { it.id }) { run ->
                RunSummaryCard(run = run)
            }
        }
        item { WorkbenchSectionHeader("Coding Tools", "本机 CLI 探测与执行状态 · 点击查看详情", onClick = onOpenCodingTools) }
        item {
            CodingToolsCard(
                items = toolItems,
                loading = state.workbenchLoading,
                onInstall = onInstallCodingTools,
                onRepair = onRepairCodingTools,
                onClick = onOpenCodingTools,
            )
        }
        item { WorkbenchSectionHeader("Skills", "安装与本地发现 · 点击查看详情", onClick = onOpenSkillsMarket) }
        item {
            SkillsCard(
                skills = skills,
                onRefresh = onRefresh,
                onClick = onOpenSkillsMarket,
            )
        }
        item { WorkbenchSectionHeader("模型与运行时", "LLM 连接状态 · 点击查看详情", onClick = onOpenModelManagement) }
        item {
            RuntimeInfoCard(
                provider = workbench?.runtime?.provider.orEmpty(),
                model = workbench?.runtime?.model.orEmpty(),
                source = workbench?.runtime?.source.orEmpty(),
                apiKeyConfigured = workbench?.runtime?.apiKeyConfigured == true,
                onClick = onOpenModelManagement,
            )
        }
        item { WorkbenchSectionHeader("办公室与网络", "Star Office 与局域网连通性 · 点击查看详情", onClick = onOpenOffice) }
        item {
            OfficeNetworkCard(
                officeRunning = workbench?.office?.running == true,
                officeUrl = workbench?.office?.url.orEmpty(),
                officeError = workbench?.office?.error,
                networkMessage = workbench?.connectivity?.message.orEmpty(),
                onStartOffice = onStartOffice,
                onOpenFirewall = onOpenFirewall,
                onClick = onOpenOffice,
            )
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
private fun RunSummaryCard(run: MobileWorkbenchRunSummary) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(PanelBackground)
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
            WorkbenchChip(run.status)
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

private fun formatWorkbenchDate(value: String): String {
    return value.substringBefore('T').ifBlank { value }
}

@Composable
private fun ProfileScreen(state: MobileUiState, onDisconnect: () -> Unit, onScanQr: () -> Unit) {
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
                        Text("AH", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 28.sp)
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
                    "AgentHub Mobile",
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

        // Actions section
        item {
            Column(modifier = Modifier.background(PanelBackground)) {
                ProfileSettingsAction(
                    label = "扫码连接电脑端",
                    icon = "📷",
                    accent = true,
                    onClick = onScanQr,
                )
                ProfileSettingsDivider()
                ProfileSettingsAction(
                    label = "断开电脑端",
                    icon = "🔌",
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
private fun ProfileSettingsAction(label: String, icon: String, accent: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(icon, fontSize = 20.sp)
        Spacer(modifier = Modifier.width(14.dp))
        Text(
            label,
            color = if (accent) TgBlue else if (enabled) Ink else MutedText,
            fontSize = 15.sp,
            fontWeight = FontWeight.Normal,
        )
    }
}

@Composable
private fun FeatureHero(title: String, subtitle: String, icon: String, action: String, onAction: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(PanelBackground)
            .padding(horizontal = 16.dp, vertical = 16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(icon, fontSize = 20.sp)
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
                    .heightIn(min = 22.dp, max = 108.dp),
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
            .padding(horizontal = 10.dp, vertical = 3.dp),
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
                .border(
                    width = if (streaming && !isUser) 1.dp else if (!isUser) 0.5.dp else 0.dp,
                    color = if (streaming && !isUser) TgBlue.copy(alpha = 0.45f) else if (!isUser) Hairline else Color.Transparent,
                    shape = bubbleShape,
                )
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
    }
}

@Composable
private fun MessageBodyContent(content: String, textColor: Color) {
    val segments = remember(content) { splitMessageBody(content) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        segments.forEach { segment ->
            if (segment.isCode) {
                CodeBlockPreview(language = segment.language, code = segment.text)
            } else if (segment.text.isNotBlank()) {
                Text(
                    text = segment.text.trimEnd(),
                    color = textColor,
                    fontSize = 15.sp,
                    lineHeight = 21.sp,
                )
            }
        }
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
        painter = painterResource(R.drawable.ic_agenthub),
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
    Text(
        text = label,
        modifier = Modifier
            .size(34.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(PanelElevated)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 2.dp),
        color = Ink,
        fontSize = 26.sp,
        fontWeight = FontWeight.Medium,
    )
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text = text,
        modifier = Modifier
            .fillMaxWidth()
            .background(PageBackground)
            .padding(horizontal = 16.dp, vertical = 6.dp),
        color = MutedText,
        fontSize = 14.sp,
        fontWeight = FontWeight.SemiBold,
    )
}

private data class MessageBodySegment(
    val text: String,
    val language: String? = null,
    val isCode: Boolean = false,
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
    if (url.startsWith("http://") || url.startsWith("https://")) return url
    val cleanBase = baseUrl?.trim()?.trimEnd('/') ?: return url
    return if (url.startsWith("/")) "$cleanBase$url" else "$cleanBase/$url"
}

private fun encodeUrl(value: String): String {
    return URLEncoder.encode(value, "UTF-8")
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
