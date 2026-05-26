package com.agenthub.mobile.ui.screens

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
private val MutedText = Color(0xFF71716B)

@Composable
fun ChatShell(
    state: MobileUiState,
    onDisconnect: () -> Unit,
    onRefresh: () -> Unit,
    onCreateSession: () -> Unit,
    onSelectSession: (String) -> Unit,
    onSendMessage: (String) -> Unit,
) {
    var showSessions by remember { mutableStateOf(true) }

    LaunchedEffect(state.selectedSessionId) {
        if (state.selectedSessionId != null) showSessions = false
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(PageBackground),
    ) {
        MobileTopBar(
            subtitle = if (showSessions) "消息" else state.selectedSession?.title.orEmpty().ifBlank { "对话" },
            connected = state.connected,
            onOpenSessions = { showSessions = !showSessions },
            onDisconnect = onDisconnect,
        )
        if (!state.error.isNullOrBlank()) {
            Text(
                text = state.error,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.error.copy(alpha = 0.1f))
                    .padding(horizontal = 18.dp, vertical = 8.dp),
                color = MaterialTheme.colorScheme.error,
                fontSize = 12.sp,
            )
        }
        if (showSessions) {
            Box(modifier = Modifier.fillMaxSize()) {
                SessionListScreen(
                    sessions = state.sessions,
                    selectedSessionId = state.selectedSessionId,
                    onRefresh = onRefresh,
                    onCreateSession = onCreateSession,
                    onSelect = {
                        onSelectSession(it.id)
                        showSessions = false
                    },
                )
                MainTabBar(
                    modifier = Modifier.align(Alignment.BottomCenter),
                    active = "消息",
                )
            }
        } else {
            ConversationScreen(
                state = state,
                onOpenSessions = { showSessions = true },
                onSendMessage = onSendMessage,
            )
        }
    }
}

@Composable
private fun MobileTopBar(
    subtitle: String,
    connected: Boolean,
    onOpenSessions: () -> Unit,
    onDisconnect: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .background(Color.White)
            .border(width = 0.5.dp, color = Hairline)
            .padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "□",
            modifier = Modifier
                .clip(RoundedCornerShape(8.dp))
                .clickable(onClick = onOpenSessions)
                .padding(8.dp),
            color = Color(0xFF5F625C),
            fontSize = 18.sp,
        )
        Spacer(modifier = Modifier.width(10.dp))
        Text(
            text = "AgentHub",
            color = Color(0xFF111111),
            fontWeight = FontWeight.Bold,
            fontSize = 15.sp,
        )
        Text(
            text = "  /  $subtitle",
            color = MutedText,
            fontSize = 14.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Text(
            text = if (connected) "在线" else "重连",
            color = if (connected) Color(0xFF6F8F45) else MaterialTheme.colorScheme.error,
            fontSize = 12.sp,
            modifier = Modifier.padding(horizontal = 8.dp),
        )
        Text(
            text = "断开",
            modifier = Modifier
                .clip(RoundedCornerShape(999.dp))
                .clickable(onClick = onDisconnect)
                .padding(horizontal = 8.dp, vertical = 6.dp),
            color = MutedText,
            fontSize = 12.sp,
        )
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
                    .background(Color(0xFFF1F1EE))
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
                    .background(Color(0xFF171717))
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
            QuickEntry(title = "新对话", desc = "选择 Agent", onClick = onCreateSession, modifier = Modifier.weight(1f))
            QuickEntry(title = "同步", desc = "刷新消息", onClick = onRefresh, modifier = Modifier.weight(1f))
        }
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(top = 10.dp, bottom = 78.dp),
            verticalArrangement = Arrangement.spacedBy(0.dp),
        ) {
            item {
                Text(
                    text = "最近消息",
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
                    color = MutedText,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                )
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
private fun QuickEntry(title: String, desc: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(18.dp))
            .background(Color.White)
            .border(1.dp, Hairline, RoundedCornerShape(18.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        Text(text = title, color = Color(0xFF171717), fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
        Text(text = desc, modifier = Modifier.padding(top = 4.dp), color = MutedText, fontSize = 12.sp)
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
        Text("还没有消息", color = Color(0xFF171717), fontWeight = FontWeight.Bold, fontSize = 20.sp)
        Text(
            "新建一个 Agent 对话，或从电脑端同步已有会话。",
            modifier = Modifier.padding(top = 8.dp),
            color = MutedText,
            fontSize = 14.sp,
        )
        Button(
            onClick = onCreateSession,
            modifier = Modifier.padding(top = 18.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF171717)),
        ) {
            Text("新建对话")
        }
    }
}

@Composable
private fun SessionRow(session: Session, selected: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color.White)
            .clickable(onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(46.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(if (session.type == "group") Color(0xFF171717) else Color(0xFF7A8F5A)),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = session.title.ifBlank { "A" }.take(1).uppercase(),
                color = Color.White,
                fontWeight = FontWeight.Bold,
                fontSize = 17.sp,
            )
        }
        Spacer(modifier = Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = session.title.ifBlank { "未命名会话" },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    fontWeight = FontWeight.SemiBold,
                    color = Color(0xFF171717),
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
                    .background(Color(0xFF7A8F5A)),
            )
        }
    }
}

@Composable
private fun MainTabBar(modifier: Modifier = Modifier, active: String) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(Color.White)
            .border(0.5.dp, Hairline)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceAround,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TabItem(label = "消息", symbol = "●", active = active == "消息")
        TabItem(label = "Agent", symbol = "◆", active = active == "Agent")
        TabItem(label = "工作台", symbol = "▣", active = active == "工作台")
        TabItem(label = "我的", symbol = "○", active = active == "我的")
    }
}

@Composable
private fun TabItem(label: String, symbol: String, active: Boolean) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            text = symbol,
            color = if (active) Color(0xFF171717) else MutedText,
            fontSize = 18.sp,
            fontWeight = if (active) FontWeight.Bold else FontWeight.Normal,
        )
        Text(
            text = label,
            modifier = Modifier.padding(top = 2.dp),
            color = if (active) Color(0xFF171717) else MutedText,
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
                .padding(horizontal = 32.dp, vertical = 16.dp),
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
            color = Color(0xFF171717),
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
            subtitle = "帮我单开一个跳跃小游戏",
            onClick = { onSuggestion("创建 coder 代理，帮我单开一个跳跃小游戏") },
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
            .background(Color.White)
            .border(1.dp, Color(0xFFE1DFD8), RoundedCornerShape(20.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 17.dp),
    ) {
        Text(
            text = title,
            color = Color(0xFF171717),
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
        )
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
            .background(Color.White)
            .border(1.dp, Color(0xFFE1DFD8), RoundedCornerShape(22.dp))
            .padding(horizontal = 20.dp, vertical = 16.dp),
    ) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 44.dp, max = 104.dp),
            textStyle = TextStyle(
                color = Color(0xFF171717),
                fontSize = 15.sp,
                lineHeight = 22.sp,
            ),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { onSend() }),
            decorationBox = { innerTextField ->
                Box {
                    if (value.isBlank()) {
                        Text(
                            text = "发消息给 AgentHub，@ 可提及 Agent",
                            color = MutedText,
                            fontSize = 14.sp,
                        )
                    }
                    innerTextField()
                }
            },
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ComposerTool("+")
            ComposerTool("□")
            ComposerTool("⌁")
            ComposerTool("@")
            Spacer(modifier = Modifier.weight(1f))
            Text(
                text = "自动⌄",
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
                    .background(if (value.isBlank()) Color(0xFFE8E8E5) else Color(0xFF171717))
                    .clickable(enabled = value.isNotBlank(), onClick = onSend),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "↑",
                    color = if (value.isBlank()) Color.White else Color.White,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                )
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
                .background(if (isUser) Color(0xFF171717) else Color.White)
                .border(
                    width = 1.dp,
                    color = if (isUser) Color(0xFF171717) else Hairline,
                    shape = RoundedCornerShape(20.dp),
                )
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
                color = if (isUser) Color.White else Color(0xFF171717),
                lineHeight = 20.sp,
            )
        }
    }
}

private fun senderLabel(message: Message): String {
    return when (message.senderType) {
        "agent" -> "Agent"
        "system" -> "System"
        else -> message.senderType.ifBlank { "AgentHub" }
    }
}
