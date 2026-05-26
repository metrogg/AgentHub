package com.agenthub.mobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val AgentHubLightColors = lightColorScheme(
    primary = Color(0xFF171717),
    onPrimary = Color(0xFFFFFFFF),
    background = Color(0xFFFCFCFA),
    onBackground = Color(0xFF171717),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF171717),
    surfaceVariant = Color(0xFFF5F5F2),
    onSurfaceVariant = Color(0xFF6F6F68),
    outline = Color(0xFFE2E0DA),
    secondary = Color(0xFF7A8F5A),
    onSecondary = Color(0xFFFFFFFF),
    error = Color(0xFFB42318),
)

@Composable
fun AgentHubTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = AgentHubLightColors,
        content = content,
    )
}
