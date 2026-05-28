package com.agenthub.mobile.ui.screens

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.ExperimentalAnimationApi
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agenthub.mobile.data.Message
import com.agenthub.mobile.data.MobileUiState
import com.agenthub.mobile.data.Session

private val Hairline = Color(0xFFE8E6E0)
private val PageBackground = Color(0xFFFCFCFA)
private val PanelBackground = Color(0xFFFFFFFF)
private val Ink = Color(0xFF171717)
private val MutedText = Color(0xFF71716B)
private val SoftFill = Color(0xFFF1F1EE)
private val AgentGreen = Color(0xFF7A8F5A)
private val WorkAmber = Color(0xFFF2A23A)

private enum class MobileTab(val label: String, val icon: String) {
    Messages("消息", "◉"),
    Agents("Agent", "✦"),
    Workbench("工作台", "▣"),
    Me("我的", "●"),
}

@OptIn(ExperimentalAnimationApi::class)
@Composable
fun ChatShell(
    state: MobileUiState,
    onDisconnect: () -> Unit,
    onRefresh: () -> Unit,
    onCreateSession: () -> Unit,
    onSelectSession: (String) -> Unit,
    onSendMessage: (String) -> Unit,
) {
    var currentTab by remember { mutableStateOf(MobileTab.Messages) }
    var showSessions by remember { mutableStateOf(true) }

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
                showSessions -> "消息"
                else -> state.selectedSession?.title.orEmpty().ifBlank { "对话" }
            },
            connected = state.connected,
            showBack = currentTab == MobileTab.Messages && !showSessions,
            onBack = { showSessions = true },
            onDisconnect = onDisconnect,
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
                    .background(MaterialTheme.colorScheme.error.copy(alpha = 0.1f))
                    .padding(horizontal = 18.dp, vertical = 8.dp),
                color = MaterialTheme.colorScheme.error,
                fontSize = 12.sp,
            )
        }

        Box(modifier = Modifier.weight(1f)) {
            AnimatedContent(
                targetState = currentTab,
                transitionSpec = {
                    (fadeIn() + slideInHorizontally { it / 5 }).togetherWith(fadeOut()).using(SizeTransform(clip = false))
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
                    )
                    MobileTab.Agents -> AgentDirectoryScreen(state = state, onCreateSession = onCreateSession)
                    MobileTab.Workbench -> WorkbenchScreen(state = state, onRefresh = onRefresh, onCreateSession = onCreateSession)
                    MobileTab.Me -> ProfileScreen(state = state, onDisconnect = onDisconnect)
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
    onBack: () -> Unit,
    onDisconnect: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(58.dp)
            .background(PanelBackground)
            .border(width = 0.5.dp, color = Hairline)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (showBack) {
            TopIconButton(label = "‹", onClick = onBack)
        } else {
            AgentHubLogo(size = 34.dp)
        }
        Spacer(modifier = Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(title, color = Ink, fontWeight = FontWeight.Bold, fontSize = 17.sp, maxLines = 1)
            Text(
                if (connected) "电脑端在线，流式同步中" else "正在等待电脑端连接",
                color = if (connected) AgentGreen else MutedText,
                fontSize = 11.sp,
                maxLines = 1,
            )
        }
        ConnectionPill(connected = connected)
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = "断开",
            modifier = Modifier
                .clip(RoundedCornerShape(999.dp))
                .clickable(onClick = onDisconnect)
                .padding(horizontal = 9.dp, vertical = 7.dp),
            color = MutedText,
            fontSize = 12.sp,
        )
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
                onRefresh = onRefresh,
                onCreateSession = onCreateSession,
                onSelect = onOpenConversation,
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
    onRefresh: () -> Unit,
    onCreateSession: () -> Unit,
    onSelect: (Session) -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 18.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "搜索会话、Agent 或任务",
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(14.dp))
                    .background(SoftFill)
                    .padding(horizontal = 14.dp, vertical = 11.dp),
                color = MutedText,
                fontSize = 14.sp,
            )
            Spacer(modifier = Modifier.width(10.dp))
            Text(
                text = "+",
                modifier = Modifier
                    .size(42.dp)
                    .clip(CircleShape)
                    .background(Ink)
                    .clickable(onClick = onCreateSession)
                    .padding(top = 4.dp),
                color = Color.White,
                fontSize = 25.sp,
                fontWeight = FontWeight.Medium,
            )
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 18.dp, vertical = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            QuickEntry(title = "新对话", desc = "选择 Agent", icon = "+", onClick = onCreateSession, modifier = Modifier.weight(1f))
            QuickEntry(title = "同步", desc = "刷新消息", icon = "↻", onClick = onRefresh, modifier = Modifier.weight(1f))
        }
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(top = 10.dp, bottom = 84.dp),
            verticalArrangement = Arrangement.spacedBy(0.dp),
        ) {
            item {
                SectionTitle("最近消息")
            }
            items(sessions, key = { it.id }) { session ->
                SessionRow(
                    session = session,
                    selected = session.id == selectedSessionId,
                    onClick = { onSelect(session) },
                )
            }
            if (sessions.isEmpty()) {
                item {
                    EmptySessionList(onCreateSession = onCreateSession)
                }
            }
            item { Spacer(modifier = Modifier.height(24.dp)) }
        }
    }
}

@Composable
private fun QuickEntry(title: String, desc: String, icon: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(18.dp))
            .background(PanelBackground)
            .border(1.dp, Hairline, RoundedCornerShape(18.dp))
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
private fun EmptySessionList(onCreateSession: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 28.dp, vertical = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        AgentHubLogo(size = 58.dp)
        Text("还没有消息", modifier = Modifier.padding(top = 16.dp), color = Ink, fontWeight = FontWeight.Bold, fontSize = 20.sp)
        Text(
            "新建一个 Agent 对话，或从电脑端同步已有会话。",
            modifier = Modifier.padding(top = 8.dp),
            color = MutedText,
            fontSize = 14.sp,
        )
        Button(
            onClick = onCreateSession,
            modifier = Modifier.padding(top = 18.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Ink),
        ) {
            Text("新建对话")
        }
    }
}

@Composable
private fun SessionRow(session: Session, selected: Boolean, onClick: () -> Unit) {
    val scale by animateFloatAsState(
        targetValue = if (selected) 0.985f else 1f,
        animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
        label = "session-scale",
    )
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .scale(scale)
            .background(if (selected) Color(0xFFF6F7F1) else PanelBackground)
            .clickable(onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 12.dp),
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
                text = if (session.type == "group") "Agent Group · 多 Agent 协作群" else "Direct Agent · 单聊",
                modifier = Modifier.padding(top = 5.dp),
                color = MutedText,
                fontSize = 13.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (selected) {
            Spacer(modifier = Modifier.width(8.dp))
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(AgentGreen),
            )
        }
    }
}

@Composable
private fun MainTabBar(modifier: Modifier = Modifier, active: MobileTab, onSelect: (MobileTab) -> Unit) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(PanelBackground)
            .border(0.5.dp, Hairline)
            .padding(horizontal = 8.dp, vertical = 8.dp),
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
    val scale by animateFloatAsState(if (active) 1.04f else 1f, label = "tab-scale")
    Column(
        modifier = Modifier
            .clip(RoundedCornerShape(14.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 3.dp)
            .scale(scale),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = tab.icon,
            color = if (active) Ink else MutedText,
            fontSize = 18.sp,
            fontWeight = if (active) FontWeight.Bold else FontWeight.Normal,
        )
        Text(
            text = tab.label,
            modifier = Modifier.padding(top = 2.dp),
            color = if (active) Ink else MutedText,
            fontSize = 11.sp,
            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        )
    }
}

@Composable
private fun ConversationScreen(
    state: MobileUiState,
    onOpenSessions: () -> Unit,
    onSendMessage: (String) -> Unit,
) {
    var input by remember(state.selectedSessionId) { mutableStateOf("") }
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
                    .padding(horizontal = 32.dp),
                onSuggestion = onSendMessage,
            )
        } else {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(bottom = 142.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item { Spacer(modifier = Modifier.height(12.dp)) }
                items(messages, key = { it.id }) { message ->
                    MessageBubble(message)
                }
                if (state.agentTyping && state.streamingMessage == null) {
                    item {
                        Text(
                            text = "Agent 正在思考...",
                            modifier = Modifier.padding(horizontal = 18.dp, vertical = 6.dp),
                            color = MutedText,
                            fontSize = 12.sp,
                        )
                    }
                }
                item { Spacer(modifier = Modifier.height(18.dp)) }
            }
        }

        ChatComposer(
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
                .padding(horizontal = 18.dp, vertical = 16.dp),
        )
    }
}

@Composable
private fun MobileHomeContent(
    modifier: Modifier,
    onSuggestion: (String) -> Unit,
) {
    Column(modifier = modifier) {
        Spacer(modifier = Modifier.weight(0.9f))
        Text(
            text = "有什么可以帮忙的？",
            color = Ink,
            fontSize = 27.sp,
            lineHeight = 34.sp,
            fontWeight = FontWeight.Bold,
        )
        Text(
            text = "创建 Agent、拆解任务，或直接 @ 某个助手开始协作。",
            modifier = Modifier.padding(top = 12.dp),
            color = MutedText,
            fontSize = 16.sp,
            lineHeight = 24.sp,
        )
        Spacer(modifier = Modifier.height(96.dp))
        SuggestionCard(
            title = "创建 coder 代理",
            subtitle = "帮我开发一个网页跳跃小游戏",
            onClick = { onSuggestion("创建 coder 代理，帮我开发一个网页跳跃小游戏") },
        )
        Spacer(modifier = Modifier.height(12.dp))
        SuggestionCard(
            title = "解释架构",
            subtitle = "这个项目的具体技术栈",
            onClick = { onSuggestion("解释架构：这个项目的具体技术栈") },
        )
        Spacer(modifier = Modifier.weight(1.4f))
    }
}

@Composable
private fun SuggestionCard(title: String, subtitle: String, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(PanelBackground)
            .border(1.dp, Color(0xFFE1DFD8), RoundedCornerShape(20.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 17.dp),
    ) {
        Text(title, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium)
        Text(
            text = subtitle,
            modifier = Modifier.padding(top = 6.dp),
            color = MutedText,
            fontSize = 14.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun AgentDirectoryScreen(state: MobileUiState, onCreateSession: () -> Unit) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 18.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            FeatureHero(
                title = "Agent 联系人",
                subtitle = "每个 Agent 都像一个聊天对象。当前会话中发现 ${state.sessions.count { it.workspaceAgentId != null }} 个 Agent 入口。",
                icon = "✦",
                action = "新建对话",
                onAction = onCreateSession,
            )
        }
        items(state.sessions.filter { it.workspaceAgentId != null }.ifEmpty { state.sessions.take(3) }, key = { it.id }) { session ->
            SessionRow(session = session, selected = false, onClick = onCreateSession)
        }
        item { Spacer(modifier = Modifier.height(84.dp)) }
    }
}

@Composable
private fun WorkbenchScreen(state: MobileUiState, onRefresh: () -> Unit, onCreateSession: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 18.dp, vertical = 16.dp),
    ) {
        FeatureHero(
            title = "移动工作台",
            subtitle = "查看同步状态、审批确认、预览产物。电脑端继续运行，手机端负责轻量控制。",
            icon = "▣",
            action = "同步",
            onAction = onRefresh,
        )
        Spacer(modifier = Modifier.height(14.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            MetricCard("会话", state.sessions.size.toString(), Modifier.weight(1f))
            MetricCard("在线", if (state.connected) "1" else "0", Modifier.weight(1f))
            MetricCard("流式", if (state.streamingMessage != null) "ON" else "OFF", Modifier.weight(1f))
        }
        Spacer(modifier = Modifier.height(14.dp))
        QuickEntry("新任务", "发给电脑端执行", "+", onCreateSession)
    }
}

@Composable
private fun ProfileScreen(state: MobileUiState, onDisconnect: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 18.dp, vertical = 18.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            AgentHubLogo(size = 56.dp)
            Spacer(modifier = Modifier.width(14.dp))
            Column {
                Text("AgentHub Mobile", color = Ink, fontWeight = FontWeight.Bold, fontSize = 20.sp)
                Text(state.connection?.baseUrl ?: "未连接", color = MutedText, fontSize = 13.sp)
            }
        }
        Spacer(modifier = Modifier.height(18.dp))
        ProfileRow("设备名", state.connection?.deviceName ?: "Android")
        ProfileRow("连接状态", if (state.connected) "在线" else "离线")
        ProfileRow("会话数量", state.sessions.size.toString())
        Spacer(modifier = Modifier.height(18.dp))
        Button(
            onClick = onDisconnect,
            colors = ButtonDefaults.buttonColors(containerColor = Ink),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("断开电脑端")
        }
    }
}

@Composable
private fun FeatureHero(title: String, subtitle: String, icon: String, action: String, onAction: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(PanelBackground)
            .border(1.dp, Hairline, RoundedCornerShape(24.dp))
            .padding(18.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(icon, fontSize = 26.sp, color = Ink)
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
            .clip(RoundedCornerShape(18.dp))
            .background(PanelBackground)
            .border(1.dp, Hairline, RoundedCornerShape(18.dp))
            .padding(14.dp),
    ) {
        Text(value, color = Ink, fontWeight = FontWeight.Bold, fontSize = 20.sp)
        Text(label, modifier = Modifier.padding(top = 4.dp), color = MutedText, fontSize = 12.sp)
    }
}

@Composable
private fun ProfileRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .border(0.5.dp, Hairline)
            .padding(vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = MutedText, modifier = Modifier.weight(1f))
        Text(value, color = Ink, fontWeight = FontWeight.Medium)
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
            .clip(RoundedCornerShape(22.dp))
            .background(PanelBackground)
            .border(1.dp, Color(0xFFE1DFD8), RoundedCornerShape(22.dp))
            .padding(horizontal = 18.dp, vertical = 15.dp),
    ) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 44.dp, max = 104.dp),
            textStyle = TextStyle(color = Ink, fontSize = 15.sp, lineHeight = 22.sp),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { onSend() }),
            decorationBox = { innerTextField ->
                Box {
                    if (value.isBlank()) {
                        Text("发消息给 AgentHub，@ 可提及 Agent", color = MutedText, fontSize = 14.sp)
                    }
                    innerTextField()
                }
            },
        )
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            listOf("+", "□", "⌁", "@").forEach { ComposerTool(it) }
            Spacer(modifier = Modifier.weight(1f))
            Text(
                text = "自动",
                modifier = Modifier
                    .clip(RoundedCornerShape(999.dp))
                    .border(1.dp, Color(0xFFE1DFD8), RoundedCornerShape(999.dp))
                    .padding(horizontal = 14.dp, vertical = 8.dp),
                color = Color(0xFF55554F),
                fontSize = 13.sp,
            )
            Spacer(modifier = Modifier.width(10.dp))
            Box(
                modifier = Modifier
                    .size(38.dp)
                    .clip(CircleShape)
                    .background(if (value.isBlank()) Color(0xFFE8E8E5) else Ink)
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
private fun MessageBubble(message: Message) {
    val isUser = message.senderType == "user"
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 18.dp),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth(0.86f)
                .clip(RoundedCornerShape(20.dp))
                .background(if (isUser) Ink else PanelBackground)
                .border(1.dp, if (isUser) Ink else Hairline, RoundedCornerShape(20.dp))
                .padding(14.dp),
        ) {
            Text(
                text = if (isUser) "你" else senderLabel(message),
                color = if (isUser) Color.White.copy(alpha = 0.72f) else MutedText,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = message.content.ifBlank { " " },
                modifier = Modifier.padding(top = 6.dp),
                color = if (isUser) Color.White else Ink,
                lineHeight = 20.sp,
            )
        }
    }
}

@Composable
private fun AgentHubLogo(size: androidx.compose.ui.unit.Dp) {
    Box(
        modifier = Modifier
            .size(size)
            .clip(RoundedCornerShape(size / 3))
            .background(Ink),
        contentAlignment = Alignment.Center,
    ) {
        Text("AH", color = Color.White, fontWeight = FontWeight.Black, fontSize = (size.value * 0.32f).sp)
    }
}

@Composable
private fun SessionAvatar(session: Session) {
    val color = when {
        session.type == "group" -> Ink
        session.workspaceAgentId != null -> AgentGreen
        else -> WorkAmber
    }
    Box(
        modifier = Modifier
            .size(46.dp)
            .clip(RoundedCornerShape(14.dp))
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
private fun ConnectionPill(connected: Boolean) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (connected) Color(0xFFEAF3DD) else Color(0xFFF4EFED))
            .padding(horizontal = 9.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(7.dp)
                .clip(CircleShape)
                .background(if (connected) AgentGreen else Color(0xFFB42318)),
        )
        Spacer(modifier = Modifier.width(5.dp))
        Text(if (connected) "在线" else "离线", color = if (connected) AgentGreen else Color(0xFFB42318), fontSize = 12.sp)
    }
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

private fun senderLabel(message: Message): String {
    return when (message.senderType) {
        "agent" -> "Agent"
        "system" -> "System"
        else -> message.senderType.ifBlank { "AgentHub" }
    }
}
