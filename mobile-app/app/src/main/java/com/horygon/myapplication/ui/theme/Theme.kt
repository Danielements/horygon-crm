package com.horygon.myapplication.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val AppColors = darkColorScheme(
    primary = Color(0xFF0A5CFF),
    onPrimary = Color(0xFFF7FAFF),
    primaryContainer = Color(0xFF0C2352),
    onPrimaryContainer = Color(0xFFF1F5FF),
    secondary = Color(0xFF6FA8FF),
    onSecondary = Color(0xFFF6FAFF),
    secondaryContainer = Color(0xFF12274F),
    onSecondaryContainer = Color(0xFFEAF1FF),
    tertiary = Color(0xFF9FC2FF),
    onTertiary = Color(0xFFF8FBFF),
    background = Color(0xFF000000),
    onBackground = Color(0xFFF2F6FF),
    surface = Color(0xFF08111F),
    onSurface = Color(0xFFEAF1FF),
    surfaceVariant = Color(0xFF101C34),
    onSurfaceVariant = Color(0xFFC8D6F2),
    outline = Color(0xFF2F4E86)
)

@Composable
fun HorygonTabletTheme(
    content: @Composable () -> Unit
) {
    MaterialTheme(
        colorScheme = AppColors,
        typography = AppTypography,
        content = content
    )
}
