package com.agenthub.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agenthub.mobile.data.MobileUiState
import com.agenthub.mobile.data.TestModelRequest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

private val Ink = Color(0xFFF4F7FA)
private val MutedText = Color(0xFF92A0AE)
private val PanelBackground = Color(0xFF1B2530)
private val PageBackground = Color(0xFF121B24)
private val TgBlue = Color(0xFF4EA2F6)
private val SuccessGreen = Color(0xFF55D66B)
private val ErrorRed = Color(0xFFFF6B78)
private val SoftFill = Color(0xFF22303F)

@Composable
fun ModelManagementScreen(
    state: MobileUiState,
    onBack: () -> Unit,
    onFetchSettings: () -> Unit,
    onUpdateSettings: (Map<String, String>) -> Unit,
    onTestModel: (TestModelRequest) -> Unit,
    onClearTestResult: () -> Unit,
    onRefresh: () -> Unit,
) {
    LaunchedEffect(Unit) {
        onFetchSettings()
    }

    val runtime = state.workbench?.runtime
    val settings = state.settings
    val catalogJson = settings["MODEL_CATALOG"]
    val activeModelId = settings["ACTIVE_MODEL_ID"].orEmpty()
    val catalogModels = remember(catalogJson) { parseModelCatalog(catalogJson) }

    var showAddDialog by remember { mutableStateOf(false) }
    var showEditDialog by remember { mutableStateOf<Pair<Int, CatalogModel>?>(null) }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .background(PageBackground)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // Current runtime status
        item {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(PanelBackground)
                    .padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("当前运行时", color = Ink, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                        Text(
                            if (runtime != null) "${runtime.provider} · ${runtime.model.ifBlank { "未选择" }}"
                            else "未连接电脑端",
                            color = MutedText, fontSize = 13.sp, modifier = Modifier.padding(top = 3.dp),
                        )
                    }
                    StatusChip(
                        text = if (runtime?.apiKeyConfigured == true) "Key ✓" else "No Key",
                        isPositive = runtime?.apiKeyConfigured == true,
                    )
                }
                if (runtime != null) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        InfoChip(runtime.provider.ifBlank { "unknown" })
                        InfoChip(runtime.source.ifBlank { "env" })
                        if (runtime.baseUrl.isNotBlank()) InfoChip(runtime.baseUrl.take(30))
                    }
                }
            }
        }

        // Test model result
        val testResult = state.testModelResult
        if (testResult != null) {
            item {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .background(PanelBackground)
                        .padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            if (testResult.ok) "连接测试成功" else "连接测试失败",
                            color = if (testResult.ok) SuccessGreen else ErrorRed,
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 14.sp,
                        )
                        Spacer(modifier = Modifier.weight(1f))
                        TextButton(onClick = onClearTestResult) {
                            Text("关闭", color = MutedText)
                        }
                    }
                    if (testResult.message.isNotBlank()) {
                        Text(testResult.message, color = MutedText, fontSize = 12.sp, lineHeight = 18.sp)
                    }
                    if (testResult.model != null) {
                        Text("响应模型: ${testResult.model}", color = Ink, fontSize = 12.sp)
                    }
                    if (testResult.latencyMs != null) {
                        Text("延迟: ${testResult.latencyMs}ms", color = MutedText, fontSize = 12.sp)
                    }
                }
            }
        }

        // Model catalog
        item {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 4.dp)) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("模型目录", color = Ink, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                    Text(
                        "MODEL_CATALOG 中注册的模型 · 点击切换",
                        color = MutedText, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp),
                    )
                }
                TextButton(onClick = onRefresh) { Text("同步", color = TgBlue) }
            }
        }

        if (catalogModels.isEmpty()) {
            item {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .background(PanelBackground)
                        .padding(16.dp),
                ) {
                    Text("暂无模型配置", color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                    Text(
                        "在电脑端设置中添加模型后同步到手机，或点击下方按钮添加。",
                        color = MutedText, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp), lineHeight = 18.sp,
                    )
                }
            }
        } else {
            items(catalogModels.size) { index ->
                val model = catalogModels[index]
                val isActive = model.id == activeModelId
                ModelCard(
                    model = model,
                    isActive = isActive,
                    onActivate = {
                        onUpdateSettings(mapOf("ACTIVE_MODEL_ID" to model.id))
                    },
                    onTest = {
                        onTestModel(
                            TestModelRequest(
                                provider = model.provider,
                                apiEndpoint = model.apiEndpoint,
                                anthropicEndpoint = model.anthropicEndpoint,
                                apiKey = model.apiKey,
                                apiKeyEnv = model.apiKeyEnv,
                                modelId = model.modelId,
                            ),
                        )
                    },
                    onEdit = { showEditDialog = index to model },
                )
            }
        }

        // Add model button
        item {
            OutlinedButton(
                onClick = { showAddDialog = true },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("+ 添加模型")
            }
        }

        item {
            Button(
                onClick = {
                    onTestModel(TestModelRequest())
                },
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(containerColor = TgBlue),
            ) {
                Text("测试当前默认连接")
            }
        }

        item { Spacer(modifier = Modifier.height(84.dp)) }
    }

    if (showAddDialog) {
        ModelEditDialog(
            title = "添加模型",
            initial = CatalogModel(id = "", provider = "openai", modelId = "", apiEndpoint = "", apiKey = "", apiKeyEnv = ""),
            onDismiss = { showAddDialog = false },
            onConfirm = { newModel ->
                val updated = catalogModels + newModel.copy(id = newModel.id.ifBlank { "model-${catalogModels.size}" })
                onUpdateSettings(mapOf("MODEL_CATALOG" to serializeCatalog(updated)))
                showAddDialog = false
            },
        )
    }

    showEditDialog?.let { (index, model) ->
        ModelEditDialog(
            title = "编辑模型",
            initial = model,
            onDismiss = { showEditDialog = null },
            onConfirm = { updated ->
                val newList = catalogModels.toMutableList()
                newList[index] = updated
                onUpdateSettings(mapOf("MODEL_CATALOG" to serializeCatalog(newList)))
                showEditDialog = null
            },
        )
    }
}

@Composable
private fun ModelCard(
    model: CatalogModel,
    isActive: Boolean,
    onActivate: () -> Unit,
    onTest: () -> Unit,
    onEdit: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(PanelBackground)
            .clickable(onClick = onActivate)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    model.id.ifBlank { "unnamed" },
                    color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${model.provider.orEmpty()} · ${model.modelId.orEmpty()}",
                    color = MutedText, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp),
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            if (isActive) {
                StatusChip(text = "当前", isPositive = true)
            }
        }
        if (!model.apiEndpoint.isNullOrBlank()) {
            Text(model.apiEndpoint, color = MutedText, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onTest, modifier = Modifier.weight(1f)) {
                Text("测试", fontSize = 12.sp)
            }
            OutlinedButton(onClick = onEdit, modifier = Modifier.weight(1f)) {
                Text("编辑", fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun ModelEditDialog(
    title: String,
    initial: CatalogModel,
    onDismiss: () -> Unit,
    onConfirm: (CatalogModel) -> Unit,
) {
    var id by remember { mutableStateOf(initial.id) }
    var provider by remember { mutableStateOf(initial.provider.orEmpty()) }
    var modelId by remember { mutableStateOf(initial.modelId.orEmpty()) }
    var apiEndpoint by remember { mutableStateOf(initial.apiEndpoint.orEmpty()) }
    var anthropicEndpoint by remember { mutableStateOf(initial.anthropicEndpoint.orEmpty()) }
    var apiKey by remember { mutableStateOf(initial.apiKey.orEmpty()) }
    var apiKeyEnv by remember { mutableStateOf(initial.apiKeyEnv.orEmpty()) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, fontWeight = FontWeight.Bold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = id, onValueChange = { id = it }, label = { Text("模型 ID") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(value = provider, onValueChange = { provider = it }, label = { Text("Provider (openai/anthropic/...)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(value = modelId, onValueChange = { modelId = it }, label = { Text("Model ID (gpt-4o/claude-sonnet-4-20250514/...)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(value = apiEndpoint, onValueChange = { apiEndpoint = it }, label = { Text("API Endpoint (OpenAI)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(value = anthropicEndpoint, onValueChange = { anthropicEndpoint = it }, label = { Text("Anthropic Endpoint") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(value = apiKey, onValueChange = { apiKey = it }, label = { Text("API Key") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(value = apiKeyEnv, onValueChange = { apiKeyEnv = it }, label = { Text("API Key Env Var") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    onConfirm(
                        CatalogModel(
                            id = id.trim(),
                            provider = provider.trim().ifBlank { null },
                            modelId = modelId.trim().ifBlank { null },
                            apiEndpoint = apiEndpoint.trim().ifBlank { null },
                            anthropicEndpoint = anthropicEndpoint.trim().ifBlank { null },
                            apiKey = apiKey.trim().ifBlank { null },
                            apiKeyEnv = apiKeyEnv.trim().ifBlank { null },
                        ),
                    )
                },
            ) { Text("保存", color = TgBlue) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        },
    )
}

@Composable
private fun StatusChip(text: String, isPositive: Boolean) {
    Text(
        text = text,
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (isPositive) Color(0xFF163523) else Color(0xFF3A2812))
            .padding(horizontal = 9.dp, vertical = 4.dp),
        color = if (isPositive) SuccessGreen else WorkAmber,
        fontSize = 10.sp,
        fontWeight = FontWeight.SemiBold,
    )
}

private val WorkAmber = Color(0xFFFFB04A)

@Composable
private fun InfoChip(text: String) {
    Text(
        text = text,
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(SoftFill)
            .padding(horizontal = 9.dp, vertical = 4.dp),
        color = Ink,
        fontSize = 10.sp,
        maxLines = 1,
    )
}

private data class CatalogModel(
    val id: String,
    val provider: String?,
    val modelId: String?,
    val apiEndpoint: String?,
    val anthropicEndpoint: String? = null,
    val apiKey: String?,
    val apiKeyEnv: String?,
)

private fun parseModelCatalog(jsonString: String?): List<CatalogModel> {
    if (jsonString.isNullOrBlank()) return emptyList()
    return try {
        val element = Json.parseToJsonElement(jsonString)
        when (element) {
            is JsonArray -> element.mapNotNull { parseCatalogEntry(it) }
            is JsonObject -> listOfNotNull(parseCatalogEntry(element))
            else -> emptyList()
        }
    } catch (_: Exception) {
        emptyList()
    }
}

private fun parseCatalogEntry(element: JsonElement): CatalogModel? {
    return try {
        val obj = element.jsonObject
        CatalogModel(
            id = obj["id"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            provider = obj["provider"]?.jsonPrimitive?.contentOrNull,
            modelId = obj["modelId"]?.jsonPrimitive?.contentOrNull,
            apiEndpoint = obj["apiEndpoint"]?.jsonPrimitive?.contentOrNull,
            anthropicEndpoint = obj["anthropicEndpoint"]?.jsonPrimitive?.contentOrNull,
            apiKey = obj["apiKey"]?.jsonPrimitive?.contentOrNull,
            apiKeyEnv = obj["apiKeyEnv"]?.jsonPrimitive?.contentOrNull,
        )
    } catch (_: Exception) {
        null
    }
}

private fun serializeCatalog(models: List<CatalogModel>): String {
    val elements = models.map { model ->
        buildJsonObject {
            put("id", JsonPrimitive(model.id))
            model.provider?.let { put("provider", JsonPrimitive(it)) }
            model.modelId?.let { put("modelId", JsonPrimitive(it)) }
            model.apiEndpoint?.let { put("apiEndpoint", JsonPrimitive(it)) }
            model.anthropicEndpoint?.let { put("anthropicEndpoint", JsonPrimitive(it)) }
            model.apiKey?.let { put("apiKey", JsonPrimitive(it)) }
            model.apiKeyEnv?.let { put("apiKeyEnv", JsonPrimitive(it)) }
        }
    }
    return Json.encodeToString(JsonArray.serializer(), JsonArray(elements))
}

private fun buildJsonObject(builder: MutableMap<String, JsonElement>.() -> Unit): JsonObject {
    val map = mutableMapOf<String, JsonElement>()
    builder(map)
    return JsonObject(map)
}
