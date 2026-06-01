package com.agenthub.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agenthub.mobile.data.MobileUiState
import com.agenthub.mobile.data.MobileWorkbenchSkillSummary

private val Ink = Color(0xFF000000)
private val MutedText = Color(0xFF7A7A7A)
private val PanelBackground = Color.White
private val PageBackground = Color(0xFFF5F5F5)
private val TgBlue = Color(0xFF3390EC)
private val ProfileBlue = Color(0xFF3390EC)
private val SoftFill = Color(0xFFF0F2F5)

@Composable
fun SkillsMarketScreen(
    state: MobileUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
) {
    val skills = state.workbench?.skills.orEmpty()
    var searchQuery by remember { mutableStateOf("") }

    val filteredSkills = remember(skills, searchQuery) {
        if (searchQuery.isBlank()) skills
        else skills.filter {
            it.name.contains(searchQuery, ignoreCase = true) ||
                it.description.contains(searchQuery, ignoreCase = true) ||
                it.source.contains(searchQuery, ignoreCase = true)
        }
    }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .background(PageBackground)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // Header
        item {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(PanelBackground)
                    .padding(18.dp),
            ) {
                Text("Skills 市场", color = Ink, fontWeight = FontWeight.Bold, fontSize = 20.sp)
                Text(
                    "查看电脑端已安装的 Skills，可通过搜索快速查找。",
                    color = MutedText, fontSize = 14.sp, modifier = Modifier.padding(top = 8.dp), lineHeight = 21.sp,
                )
                Spacer(modifier = Modifier.height(12.dp))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    MetricTile("已安装", "${skills.size}", Modifier.weight(1f))
                    val sources = skills.map { it.source }.filter { it.isNotBlank() }.distinct()
                    MetricTile("来源", "${sources.size}", Modifier.weight(1f))
                }
            }
        }

        // Search bar
        item {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(PanelBackground)
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("🔍", fontSize = 16.sp)
                Spacer(modifier = Modifier.width(8.dp))
                BasicTextField(
                    value = searchQuery,
                    onValueChange = { searchQuery = it },
                    modifier = Modifier.weight(1f),
                    textStyle = TextStyle(color = Ink, fontSize = 14.sp),
                    cursorBrush = SolidColor(TgBlue),
                    decorationBox = { innerTextField ->
                        Box {
                            if (searchQuery.isBlank()) {
                                Text("搜索 Skills...", color = MutedText, fontSize = 14.sp)
                            }
                            innerTextField()
                        }
                    },
                )
                if (searchQuery.isNotBlank()) {
                    TextButton(onClick = { searchQuery = "" }) {
                        Text("清除", color = TgBlue, fontSize = 12.sp)
                    }
                }
            }
        }

        // Search result count
        if (searchQuery.isNotBlank()) {
            item {
                Text(
                    "找到 ${filteredSkills.size} 个结果",
                    color = MutedText, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 4.dp),
                )
            }
        }

        // Skills list
        if (filteredSkills.isEmpty()) {
            item {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .background(PanelBackground)
                        .padding(16.dp),
                ) {
                    Text(
                        if (searchQuery.isBlank()) "暂无已安装的 Skills" else "未找到匹配的 Skills",
                        color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
                    )
                    Text(
                        if (searchQuery.isBlank()) "在电脑端安装 Skills 后，同步到手机即可查看。"
                        else "尝试其他关键词，或清除搜索条件。",
                        color = MutedText, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp), lineHeight = 18.sp,
                    )
                }
            }
        } else {
            items(filteredSkills, key = { it.id }) { skill ->
                SkillDetailCard(skill = skill)
            }
        }

        // Info card
        item {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(PanelBackground)
                    .padding(14.dp),
            ) {
                Text("关于 Skills", color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Text(
                    "Skills 是 Agent 的可复用能力模块，包含提示词、工具配置和规则。" +
                        "在电脑端的 Skills 管理页面可以安装新 Skills，安装后通过同步更新到手机端查看。",
                    color = MutedText, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp), lineHeight = 18.sp,
                )
            }
        }

        // Sync button
        item {
            OutlinedButton(
                onClick = onRefresh,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("刷新工作台数据")
            }
        }

        item { Spacer(modifier = Modifier.height(84.dp)) }
    }
}

@Composable
private fun MetricTile(label: String, value: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(Color(0xFFF7F7F7))
            .padding(12.dp),
    ) {
        Text(value, color = Ink, fontWeight = FontWeight.Bold, fontSize = 18.sp)
        Text(label, modifier = Modifier.padding(top = 3.dp), color = MutedText, fontSize = 11.sp)
    }
}

@Composable
private fun SkillDetailCard(skill: MobileWorkbenchSkillSummary) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(PanelBackground)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(ProfileBlue),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    skill.name.take(1).uppercase(),
                    color = Color.White, fontWeight = FontWeight.Bold, fontSize = 15.sp,
                )
            }
            Spacer(modifier = Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    skill.name,
                    color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 15.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                if (skill.source.isNotBlank()) {
                    Text(
                        "来源: ${skill.source}",
                        color = MutedText, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp),
                    )
                }
            }
        }

        if (skill.description.isNotBlank()) {
            Text(
                skill.description,
                color = Color(0xFF444444), fontSize = 13.sp, lineHeight = 20.sp,
            )
        }

        // Path info
        if (skill.rootPath.isNotBlank()) {
            Row {
                Text("路径: ", color = MutedText, fontSize = 11.sp)
                Text(
                    skill.rootPath,
                    color = Ink, fontSize = 11.sp, fontWeight = FontWeight.Medium,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (skill.skillPath.isNotBlank()) {
            Row {
                Text("Skill: ", color = MutedText, fontSize = 11.sp)
                Text(
                    skill.skillPath,
                    color = Ink, fontSize = 11.sp, fontWeight = FontWeight.Medium,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
