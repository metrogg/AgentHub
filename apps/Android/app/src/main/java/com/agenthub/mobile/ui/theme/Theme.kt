package com.agenthub.mobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Telegram-inspired color palette
private val AgentHubLightColors = lightColorScheme(
    primary = Color(0xFF3390EC),           // Telegram blue
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFD6E8FF),  // Light blue tint
    onPrimaryContainer = Color(0xFF001C3B),
    background = Color(0xFFFFFFFF),        // Pure white like Telegram
    onBackground = Color(0xFF000000),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF000000),
    surfaceVariant = Color(0xFFF0F2F5),    // Telegram light gray
    onSurfaceVariant = Color(0xFF6B7B8D),
    outline = Color(0xFFDADCE0),
    outlineVariant = Color(0xFFE8EAED),
    secondary = Color(0xFF4CAF50),         // Online green
    onSecondary = Color(0xFFFFFFFF),
    error = Color(0xFFE53935),
    onError = Color(0xFFFFFFFF),
    inverseSurface = Color(0xFF1B1F23),
    inverseOnSurface = Color(0xFFF1F3F5),
    inversePrimary = Color(0xFFA8C7FA),
)

@Composable
fun AgentHubTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = AgentHubLightColors,
        content = content,
    )
}
