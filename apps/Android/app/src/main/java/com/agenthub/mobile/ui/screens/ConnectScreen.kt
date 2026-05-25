package com.agenthub.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun ConnectScreen(
    connecting: Boolean,
    error: String?,
    onConnect: (baseUrl: String, authToken: String?) -> Unit,
) {
    var baseUrl by remember { mutableStateOf("http://10.0.2.2:8000") }
    var token by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.Start,
    ) {
        Text(
            text = "AgentHub",
            fontSize = 34.sp,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onBackground,
        )
        Text(
            text = "移动端轻量 IM 控制台",
            modifier = Modifier.padding(top = 8.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(modifier = Modifier.height(28.dp))
        OutlinedTextField(
            value = baseUrl,
            onValueChange = { baseUrl = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("电脑端 Server 地址") },
            singleLine = true,
        )
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 12.dp),
            label = { Text("设备 Token（配对前可留空）") },
            singleLine = true,
        )
        if (!error.isNullOrBlank()) {
            Text(
                text = error,
                modifier = Modifier.padding(top = 12.dp),
                color = MaterialTheme.colorScheme.error,
            )
        }
        Button(
            onClick = { onConnect(baseUrl, token.takeIf { it.isNotBlank() }) },
            enabled = !connecting,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 20.dp),
        ) {
            if (connecting) {
                CircularProgressIndicator(
                    modifier = Modifier.padding(end = 10.dp),
                    strokeWidth = 2.dp,
                )
            }
            Text(if (connecting) "正在连接" else "连接")
        }
        OutlinedButton(
            onClick = { },
            enabled = false,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 10.dp),
        ) {
            Text("扫码连接（下一步接入）")
        }
        Text(
            text = "模拟器默认使用 10.0.2.2 访问宿主机；真机请填写电脑局域网 IP。",
            modifier = Modifier.padding(top = 16.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontSize = 12.sp,
        )
    }
}
