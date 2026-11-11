package com.horygon.myapplication.ui

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarDefaults
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.horygon.myapplication.data.AppException
import com.horygon.myapplication.data.ChatOptionDto
import com.horygon.myapplication.data.ChatResponse
import com.horygon.myapplication.data.CrmRepository
import com.horygon.myapplication.data.ImagePayloadUtil
import com.horygon.myapplication.data.PreparedImagePayload
import com.horygon.myapplication.data.ProfileForm
import com.horygon.myapplication.data.QuoteDetailDto
import com.horygon.myapplication.data.QuoteLineDto
import com.horygon.myapplication.data.QuoteSummaryDto
import com.horygon.myapplication.data.RegisterRequest
import com.horygon.myapplication.data.SessionData
import com.horygon.myapplication.data.SessionStore
import com.horygon.myapplication.data.UiChatMessage
import com.horygon.myapplication.data.UnauthorizedException
import com.horygon.myapplication.ui.theme.HorygonTabletTheme
import kotlinx.coroutines.launch
import java.util.Locale

private enum class AuthMode { Login, Register }
private enum class MainTab(val label: String, val icon: String) {
    Chat("Chat", "C"),
    Quotes("Preventivi", "P"),
    Profile("Profilo", "F")
}

@Composable
fun HorygonTabletApp(repository: CrmRepository = remember { CrmRepository() }) {
    val context = LocalContext.current
    val sessionStore = remember { SessionStore(context) }
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }

    var session by remember { mutableStateOf(sessionStore.readSession()) }
    var authMode by remember { mutableStateOf(AuthMode.Login) }
    var baseUrl by remember { mutableStateOf(sessionStore.readBaseUrl()) }
    var loginEmail by remember { mutableStateOf("") }
    var loginPassword by remember { mutableStateOf("") }
    var registerEmail by remember { mutableStateOf("") }
    var registerPassword by remember { mutableStateOf("") }
    var registerCompany by remember { mutableStateOf("") }
    var registerPhone by remember { mutableStateOf("") }
    var authLoading by remember { mutableStateOf(false) }

    var selectedTab by remember { mutableStateOf(MainTab.Chat) }
    val chatMessages = remember { mutableStateListOf<UiChatMessage>() }
    var chatInput by remember { mutableStateOf("") }
    var chatSending by remember { mutableStateOf(false) }
    var quoteReadyBanner by remember { mutableStateOf(false) }

    var quotes by remember { mutableStateOf<List<QuoteSummaryDto>>(emptyList()) }
    var quotesLoading by remember { mutableStateOf(false) }
    var selectedQuoteId by remember { mutableStateOf<Int?>(null) }
    var selectedQuote by remember { mutableStateOf<QuoteDetailDto?>(null) }
    var quoteDetailLoading by remember { mutableStateOf(false) }

    var originalProfile by remember { mutableStateOf(ProfileForm()) }
    var currentProfile by remember { mutableStateOf(ProfileForm()) }
    var profileLoading by remember { mutableStateOf(false) }
    var profileSaving by remember { mutableStateOf(false) }

    fun showSnackbar(message: String) {
        scope.launch { snackbarHostState.showSnackbar(message) }
    }

    fun performLogout(message: String? = null) {
        sessionStore.clearSession()
        session = null
        selectedTab = MainTab.Chat
        chatMessages.clear()
        quotes = emptyList()
        selectedQuoteId = null
        selectedQuote = null
        originalProfile = ProfileForm()
        currentProfile = ProfileForm()
        quoteReadyBanner = false
        if (!message.isNullOrBlank()) showSnackbar(message)
    }

    fun handleAppError(error: Throwable, fallback: String) {
        when (error) {
            is UnauthorizedException -> performLogout(error.message ?: "Sessione scaduta.")
            is AppException -> showSnackbar(error.message ?: fallback)
            else -> showSnackbar(error.message ?: fallback)
        }
    }

    suspend fun refreshQuotes() {
        val currentSession = session ?: return
        quotesLoading = true
        try {
            quotes = repository.fetchQuotes(currentSession)
        } catch (error: Throwable) {
            handleAppError(error, "Impossibile caricare i preventivi")
        } finally {
            quotesLoading = false
        }
    }

    suspend fun refreshProfile() {
        val currentSession = session ?: return
        profileLoading = true
        try {
            val profile = repository.fetchProfile(currentSession)
            originalProfile = profile
            currentProfile = profile
        } catch (error: Throwable) {
            handleAppError(error, "Impossibile caricare il profilo")
        } finally {
            profileLoading = false
        }
    }

    fun appendAssistantMessage(response: ChatResponse) {
        chatMessages += UiChatMessage(
            id = System.currentTimeMillis(),
            isUser = false,
            text = response.reply,
            options = response.options,
            quoteGenerated = response.quoteGenerated
        )
        if (response.quoteGenerated) {
            quoteReadyBanner = true
        }
    }

    fun sendChatTurn(displayText: String? = null, payloadText: String? = displayText, imagePayload: PreparedImagePayload? = null) {
        val currentSession = session ?: return
        if (payloadText.isNullOrBlank() && imagePayload == null) return

        chatMessages += UiChatMessage(
            id = System.currentTimeMillis(),
            isUser = true,
            text = displayText,
            imageBytes = imagePayload?.previewBytes
        )
        val typingId = System.currentTimeMillis() + 1
        chatMessages += UiChatMessage(id = typingId, isUser = false, text = "Sta scrivendo...", isTyping = true)
        chatSending = true

        scope.launch {
            try {
                val response = repository.sendChat(
                    currentSession,
                    text = payloadText,
                    imageBase64 = imagePayload?.dataUri
                )
                chatMessages.removeAll { it.id == typingId }
                appendAssistantMessage(response)
            } catch (error: Throwable) {
                chatMessages.removeAll { it.id == typingId }
                handleAppError(error, "Invio messaggio non riuscito")
            } finally {
                chatSending = false
            }
        }
    }

    val galleryLauncher = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) {
            try {
                val payload = ImagePayloadUtil.fromUri(context, uri)
                sendChatTurn(displayText = "Foto inviata", payloadText = null, imagePayload = payload)
            } catch (error: Throwable) {
                handleAppError(error, "Immagine non leggibile")
            }
        }
    }

    val cameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicturePreview()) { bitmap: Bitmap? ->
        if (bitmap != null) {
            try {
                val payload = ImagePayloadUtil.fromBitmap(bitmap)
                sendChatTurn(displayText = "Foto scattata", payloadText = null, imagePayload = payload)
            } catch (error: Throwable) {
                handleAppError(error, "Foto non elaborabile")
            }
        }
    }

    LaunchedEffect(session?.token) {
        if (session != null) {
            refreshQuotes()
            refreshProfile()
        }
    }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = { SnackbarHost(hostState = snackbarHostState) }
    ) { padding ->
        if (session == null) {
            AuthScreen(
                modifier = Modifier.padding(padding),
                authMode = authMode,
                onModeChange = { authMode = it },
                baseUrl = baseUrl,
                onBaseUrlChange = {
                    baseUrl = it
                    sessionStore.saveBaseUrl(it)
                },
                loginEmail = loginEmail,
                onLoginEmailChange = { loginEmail = it },
                loginPassword = loginPassword,
                onLoginPasswordChange = { loginPassword = it },
                registerEmail = registerEmail,
                onRegisterEmailChange = { registerEmail = it },
                registerPassword = registerPassword,
                onRegisterPasswordChange = { registerPassword = it },
                registerCompany = registerCompany,
                onRegisterCompanyChange = { registerCompany = it },
                registerPhone = registerPhone,
                onRegisterPhoneChange = { registerPhone = it },
                loading = authLoading,
                onLogin = {
                    scope.launch {
                        authLoading = true
                        try {
                            val newSession = repository.login(baseUrl, loginEmail, loginPassword)
                            sessionStore.saveSession(newSession)
                            session = newSession
                            chatMessages.clear()
                            showSnackbar("Accesso effettuato")
                        } catch (error: Throwable) {
                            handleAppError(error, "Login non riuscito")
                        } finally {
                            authLoading = false
                        }
                    }
                },
                onRegister = {
                    scope.launch {
                        authLoading = true
                        try {
                            val newSession = repository.register(
                                baseUrl = baseUrl,
                                email = registerEmail,
                                password = registerPassword,
                                ragioneSociale = registerCompany,
                                telefono = registerPhone
                            )
                            sessionStore.saveSession(newSession)
                            session = newSession
                            chatMessages.clear()
                            showSnackbar("Registrazione completata")
                        } catch (error: Throwable) {
                            handleAppError(error, "Registrazione non riuscita")
                        } finally {
                            authLoading = false
                        }
                    }
                }
            )
        } else {
            MainShell(
                modifier = Modifier.padding(padding),
                session = session!!,
                selectedTab = selectedTab,
                onTabChange = { selectedTab = it },
                chatMessages = chatMessages,
                chatInput = chatInput,
                onChatInputChange = { chatInput = it },
                chatSending = chatSending,
                quoteReadyBanner = quoteReadyBanner,
                onOpenQuotesFromBanner = {
                    scope.launch {
                        refreshQuotes()
                        selectedTab = MainTab.Quotes
                        quoteReadyBanner = false
                    }
                },
                onSendText = {
                    val text = chatInput.trim()
                    if (text.isNotBlank()) {
                        sendChatTurn(displayText = text, payloadText = text, imagePayload = null)
                        chatInput = ""
                    }
                },
                onQuickReply = { option ->
                    sendChatTurn(displayText = option.label, payloadText = option.value, imagePayload = null)
                },
                onPickImage = {
                    galleryLauncher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                },
                onTakePicture = { cameraLauncher.launch(null) },
                quotes = quotes,
                quotesLoading = quotesLoading,
                selectedQuoteId = selectedQuoteId,
                selectedQuote = selectedQuote,
                quoteDetailLoading = quoteDetailLoading,
                onRefreshQuotes = { scope.launch { refreshQuotes() } },
                onOpenQuote = { quote ->
                    scope.launch {
                        quoteDetailLoading = true
                        selectedQuoteId = quote.id
                        try {
                            selectedQuote = repository.fetchQuoteDetail(session!!, quote.id)
                        } catch (error: Throwable) {
                            selectedQuoteId = null
                            handleAppError(error, "Dettaglio preventivo non disponibile")
                        } finally {
                            quoteDetailLoading = false
                        }
                    }
                },
                onCloseQuote = {
                    selectedQuoteId = null
                    selectedQuote = null
                },
                onOpenPdf = {
                    val quoteId = selectedQuote?.id ?: return@MainShell
                    scope.launch {
                        try {
                            val uri = repository.downloadQuotePdf(context, session!!, quoteId)
                            val intent = Intent(Intent.ACTION_VIEW)
                                .setDataAndType(uri, "application/pdf")
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            context.startActivity(Intent.createChooser(intent, "Apri PDF"))
                        } catch (error: Throwable) {
                            handleAppError(error, "Impossibile aprire il PDF")
                        }
                    }
                },
                currentProfile = currentProfile,
                originalProfile = originalProfile,
                profileLoading = profileLoading,
                profileSaving = profileSaving,
                onProfileChange = { currentProfile = it },
                onSaveProfile = {
                    scope.launch {
                        profileSaving = true
                        try {
                            val updated = repository.updateProfile(session!!, originalProfile, currentProfile)
                            originalProfile = updated
                            currentProfile = updated
                            showSnackbar("Profilo aggiornato")
                        } catch (error: Throwable) {
                            handleAppError(error, "Salvataggio profilo non riuscito")
                        } finally {
                            profileSaving = false
                        }
                    }
                },
                onLogout = { performLogout("Logout eseguito") }
            )
        }
    }
}

@Composable
private fun AuthScreen(
    modifier: Modifier = Modifier,
    authMode: AuthMode,
    onModeChange: (AuthMode) -> Unit,
    baseUrl: String,
    onBaseUrlChange: (String) -> Unit,
    loginEmail: String,
    onLoginEmailChange: (String) -> Unit,
    loginPassword: String,
    onLoginPasswordChange: (String) -> Unit,
    registerEmail: String,
    onRegisterEmailChange: (String) -> Unit,
    registerPassword: String,
    onRegisterPasswordChange: (String) -> Unit,
    registerCompany: String,
    onRegisterCompanyChange: (String) -> Unit,
    registerPhone: String,
    onRegisterPhoneChange: (String) -> Unit,
    loading: Boolean,
    onLogin: () -> Unit,
    onRegister: () -> Unit
) {
    var showPassword by remember { mutableStateOf(false) }
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    listOf(
                        MaterialTheme.colorScheme.background,
                        MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.72f)
                    )
                )
            )
            .padding(24.dp),
        contentAlignment = Alignment.Center
    ) {
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(28.dp),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.5f)),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
        ) {
            Column(modifier = Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    BrandMark()
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("HORYGON PARTS", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                        Text(
                            "Client Android per il CRM ricambi con chat server-side e preventivi dedicati.",
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = authMode == AuthMode.Login, onClick = { onModeChange(AuthMode.Login) }, label = { Text("Login") })
                    FilterChip(selected = authMode == AuthMode.Register, onClick = { onModeChange(AuthMode.Register) }, label = { Text("Registrazione") })
                }
                OutlinedTextField(value = baseUrl, onValueChange = onBaseUrlChange, modifier = Modifier.fillMaxWidth(), label = { Text("Base URL API") }, placeholder = { Text("https://app.horygon.com/") })
                if (authMode == AuthMode.Login) {
                    OutlinedTextField(
                        value = loginEmail,
                        onValueChange = onLoginEmailChange,
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Email") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next)
                    )
                    OutlinedTextField(
                        value = loginPassword,
                        onValueChange = onLoginPasswordChange,
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Password") },
                        singleLine = true,
                        visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done)
                    )
                    Button(onClick = onLogin, enabled = !loading && loginEmail.isNotBlank() && loginPassword.length >= 6, modifier = Modifier.fillMaxWidth()) {
                        AuthButtonLabel(loading, "Accedi")
                    }
                } else {
                    OutlinedTextField(
                        value = registerEmail,
                        onValueChange = onRegisterEmailChange,
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Email") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next)
                    )
                    OutlinedTextField(
                        value = registerPassword,
                        onValueChange = onRegisterPasswordChange,
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Password (min 6)") },
                        singleLine = true,
                        visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Next)
                    )
                    OutlinedTextField(value = registerCompany, onValueChange = onRegisterCompanyChange, modifier = Modifier.fillMaxWidth(), label = { Text("Ragione sociale (opzionale)") })
                    OutlinedTextField(value = registerPhone, onValueChange = onRegisterPhoneChange, modifier = Modifier.fillMaxWidth(), label = { Text("Telefono (opzionale)") })
                    Button(onClick = onRegister, enabled = !loading && registerEmail.isNotBlank() && registerPassword.length >= 6, modifier = Modifier.fillMaxWidth()) {
                        AuthButtonLabel(loading, "Registrati")
                    }
                }
                TextButton(onClick = { showPassword = !showPassword }) { Text(if (showPassword) "Nascondi password" else "Mostra password") }
            }
        }
    }
}

@Composable
private fun AuthButtonLabel(loading: Boolean, text: String) {
    if (loading) {
        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
        Spacer(Modifier.width(10.dp))
    }
    Text(text)
}

@Composable
private fun MainShell(
    modifier: Modifier = Modifier,
    session: SessionData,
    selectedTab: MainTab,
    onTabChange: (MainTab) -> Unit,
    chatMessages: List<UiChatMessage>,
    chatInput: String,
    onChatInputChange: (String) -> Unit,
    chatSending: Boolean,
    quoteReadyBanner: Boolean,
    onOpenQuotesFromBanner: () -> Unit,
    onSendText: () -> Unit,
    onQuickReply: (ChatOptionDto) -> Unit,
    onPickImage: () -> Unit,
    onTakePicture: () -> Unit,
    quotes: List<QuoteSummaryDto>,
    quotesLoading: Boolean,
    selectedQuoteId: Int?,
    selectedQuote: QuoteDetailDto?,
    quoteDetailLoading: Boolean,
    onRefreshQuotes: () -> Unit,
    onOpenQuote: (QuoteSummaryDto) -> Unit,
    onCloseQuote: () -> Unit,
    onOpenPdf: () -> Unit,
    currentProfile: ProfileForm,
    originalProfile: ProfileForm,
    profileLoading: Boolean,
    profileSaving: Boolean,
    onProfileChange: (ProfileForm) -> Unit,
    onSaveProfile: () -> Unit,
    onLogout: () -> Unit
) {
    Scaffold(
        modifier = modifier.fillMaxSize(),
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            NavigationBar(
                containerColor = MaterialTheme.colorScheme.surface,
                tonalElevation = 0.dp,
                windowInsets = NavigationBarDefaults.windowInsets
            ) {
                MainTab.entries.forEach { tab ->
                    NavigationBarItem(
                        selected = tab == selectedTab,
                        onClick = { onTabChange(tab) },
                        icon = { Text(tab.icon) },
                        label = { Text(tab.label) },
                        colors = androidx.compose.material3.NavigationBarItemDefaults.colors(
                            selectedIconColor = MaterialTheme.colorScheme.primary,
                            selectedTextColor = MaterialTheme.colorScheme.primary,
                            indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                            unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                            unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    )
                }
            }
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(innerPadding).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            TopHero(session = session, onLogout = onLogout)
            when (selectedTab) {
                MainTab.Chat -> ChatScreen(
                    messages = chatMessages,
                    chatInput = chatInput,
                    onChatInputChange = onChatInputChange,
                    onSendText = onSendText,
                    onQuickReply = onQuickReply,
                    onPickImage = onPickImage,
                    onTakePicture = onTakePicture,
                    chatSending = chatSending,
                    quoteReadyBanner = quoteReadyBanner,
                    onOpenQuotesFromBanner = onOpenQuotesFromBanner
                )
                MainTab.Quotes -> QuotesScreen(
                    quotes = quotes,
                    loading = quotesLoading,
                    selectedQuoteId = selectedQuoteId,
                    selectedQuote = selectedQuote,
                    detailLoading = quoteDetailLoading,
                    onRefresh = onRefreshQuotes,
                    onOpenQuote = onOpenQuote,
                    onCloseQuote = onCloseQuote,
                    onOpenPdf = onOpenPdf
                )
                MainTab.Profile -> ProfileScreen(
                    current = currentProfile,
                    original = originalProfile,
                    loading = profileLoading,
                    saving = profileSaving,
                    onChange = onProfileChange,
                    onSave = onSaveProfile
                )
            }
        }
    }
}

@Composable
private fun TopHero(session: SessionData, onLogout: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(28.dp),
        modifier = Modifier.fillMaxWidth(),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.55f))
    ) {
        Box(
            modifier = Modifier
                .background(
                    Brush.radialGradient(
                        colors = listOf(
                            MaterialTheme.colorScheme.primary.copy(alpha = 0.9f),
                            MaterialTheme.colorScheme.surfaceVariant,
                            MaterialTheme.colorScheme.background
                        )
                    )
                )
                .padding(20.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    BrandMark()
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("HORYGON PARTS", color = MaterialTheme.colorScheme.onPrimary, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                        Text("Cliente ${session.email}", color = MaterialTheme.colorScheme.onPrimary, style = MaterialTheme.typography.bodyLarge)
                        Text(session.baseUrl, color = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.82f), style = MaterialTheme.typography.bodySmall)
                    }
                }
                TextButton(onClick = onLogout) { Text("Logout", color = MaterialTheme.colorScheme.onPrimary) }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChatScreen(
    messages: List<UiChatMessage>,
    chatInput: String,
    onChatInputChange: (String) -> Unit,
    onSendText: () -> Unit,
    onQuickReply: (ChatOptionDto) -> Unit,
    onPickImage: () -> Unit,
    onTakePicture: () -> Unit,
    chatSending: Boolean,
    quoteReadyBanner: Boolean,
    onOpenQuotesFromBanner: () -> Unit
) {
    val latestOptionsMessageId = messages.lastOrNull { !it.isUser && it.options.isNotEmpty() }?.id
    Column(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (quoteReadyBanner) {
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
                shape = RoundedCornerShape(20.dp),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.4f))
            ) {
                Row(modifier = Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("Preventivo pronto", fontWeight = FontWeight.SemiBold)
                    Button(
                        onClick = onOpenQuotesFromBanner,
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary)
                    ) { Text("Vai ai preventivi") }
                }
            }
        }
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            contentPadding = PaddingValues(bottom = 12.dp)
        ) {
            if (messages.isEmpty()) {
                item {
                    EmptyCard("Inizia la conversazione con targa, VIN, codice OE o foto del pezzo.")
                }
            }
            items(messages, key = { it.id }) { message ->
                ChatBubble(message = message)
                if (message.id == latestOptionsMessageId && message.options.isNotEmpty()) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        message.options.forEach { option ->
                            FilterChip(selected = false, onClick = { onQuickReply(option) }, label = { Text(option.label) })
                        }
                    }
                }
            }
        }
        Card(
            shape = RoundedCornerShape(24.dp),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.35f)),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
        ) {
            Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = chatInput,
                    onValueChange = onChatInputChange,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Scrivi un messaggio") },
                    placeholder = { Text("Es. AB123CD oppure pastiglie Daily 2019") },
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    maxLines = 4
                )
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = onPickImage,
                        enabled = !chatSending,
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondaryContainer, contentColor = MaterialTheme.colorScheme.onSecondaryContainer)
                    ) { Text("Galleria") }
                    Button(
                        onClick = onTakePicture,
                        enabled = !chatSending,
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondaryContainer, contentColor = MaterialTheme.colorScheme.onSecondaryContainer)
                    ) { Text("Fotocamera") }
                    Button(
                        onClick = onSendText,
                        enabled = !chatSending && chatInput.isNotBlank(),
                        modifier = Modifier.weight(1f)
                    ) {
                        if (chatSending) {
                            CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                        } else {
                            Text("Invia")
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ChatBubble(message: UiChatMessage) {
    val alignment = if (message.isUser) Alignment.End else Alignment.Start
    val bubbleColor = if (message.isUser) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface
    val textColor = if (message.isUser) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface
    Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = alignment) {
        Card(
            shape = RoundedCornerShape(22.dp),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = if (message.isUser) 0.22f else 0.35f)),
            colors = CardDefaults.cardColors(containerColor = bubbleColor)
        ) {
            Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (message.imageBytes != null) {
                    val bitmap = remember(message.id) {
                        BitmapFactory.decodeByteArray(message.imageBytes, 0, message.imageBytes.size)
                    }
                    if (bitmap != null) {
                        Image(
                            bitmap = bitmap.asImageBitmap(),
                            contentDescription = null,
                            modifier = Modifier.fillMaxWidth().height(180.dp)
                        )
                    }
                }
                if (!message.text.isNullOrBlank()) {
                    Text(message.text, style = MaterialTheme.typography.bodyMedium, color = textColor)
                }
            }
        }
    }
}

@Composable
private fun QuotesScreen(
    quotes: List<QuoteSummaryDto>,
    loading: Boolean,
    selectedQuoteId: Int?,
    selectedQuote: QuoteDetailDto?,
    detailLoading: Boolean,
    onRefresh: () -> Unit,
    onOpenQuote: (QuoteSummaryDto) -> Unit,
    onCloseQuote: () -> Unit,
    onOpenPdf: () -> Unit
) {
    if (selectedQuoteId != null) {
        QuoteDetailScreen(quote = selectedQuote, loading = detailLoading, onBack = onCloseQuote, onOpenPdf = onOpenPdf)
        return
    }

    Column(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionHeader(title = "Preventivi", subtitle = "Elenco preventivi dal backend")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onRefresh, enabled = !loading) {
                if (loading) CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                else Text("Aggiorna")
            }
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (quotes.isEmpty() && !loading) {
                item { EmptyCard("Ancora nessun preventivo disponibile.") }
            }
            items(quotes, key = { it.id }) { quote ->
                Card(
                    modifier = Modifier.fillMaxWidth().clickable { onOpenQuote(quote) },
                    shape = RoundedCornerShape(22.dp),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.35f)),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
                ) {
                    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(quote.codice, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        InfoRow("Data", quote.data.orEmpty())
                        InfoRow("Totale", formatCurrency(quote.totale))
                        InfoRow("Stato", quote.stato.orEmpty())
                        InfoRow("Righe", quote.numRighe?.toString().orEmpty())
                    }
                }
            }
        }
    }
}

@Composable
private fun QuoteDetailScreen(
    quote: QuoteDetailDto?,
    loading: Boolean,
    onBack: () -> Unit,
    onOpenPdf: () -> Unit
) {
    Column(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("Indietro") }
            Text("Dettaglio preventivo", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        }
        if (loading) {
            EmptyCard("Sto caricando il dettaglio del preventivo...")
        } else if (quote == null) {
            EmptyCard("Dettaglio non disponibile.")
        } else {
            Card(
                shape = RoundedCornerShape(24.dp),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.35f)),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(quote.codice, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    InfoRow("Data", quote.data.orEmpty())
                    InfoRow("Imponibile", formatCurrency(quote.imponibile))
                    InfoRow("IVA", formatCurrency(quote.iva))
                    InfoRow("Totale", formatCurrency(quote.totale))
                    InfoRow("Stato", quote.stato.orEmpty())
                    Spacer(Modifier.height(4.dp))
                    Button(onClick = onOpenPdf) { Text("Scarica / Apri PDF") }
                }
            }
            SectionHeader(title = "Righe", subtitle = "Dettaglio articoli del preventivo")
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(quote.righe) { line -> QuoteLineCard(line) }
            }
        }
    }
}

@Composable
private fun QuoteLineCard(line: QuoteLineDto) {
    Card(
        shape = RoundedCornerShape(20.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.3f)),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(line.descrizione.orEmpty(), fontWeight = FontWeight.SemiBold)
            InfoRow("Quantita", line.quantita?.toString().orEmpty())
            InfoRow("Prezzo unit.", formatCurrency(line.prezzo_unitario))
            InfoRow("Totale riga", formatCurrency(line.totale_riga))
        }
    }
}

@Composable
private fun ProfileScreen(
    current: ProfileForm,
    original: ProfileForm,
    loading: Boolean,
    saving: Boolean,
    onChange: (ProfileForm) -> Unit,
    onSave: () -> Unit
) {
    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            SectionHeader(
                title = "Profilo e fatturazione",
                subtitle = if (current.isIncomplete()) "Profilo incompleto: conviene compilare almeno P.IVA e indirizzo" else "Profilo completo"
            )
        }
        item { ProfileField("Ragione sociale", current.ragioneSociale) { onChange(current.copy(ragioneSociale = it)) } }
        item { ProfileField("P.IVA", current.piva) { onChange(current.copy(piva = it)) } }
        item { ProfileField("Codice fiscale", current.cf) { onChange(current.copy(cf = it)) } }
        item { ProfileField("Indirizzo", current.indirizzo) { onChange(current.copy(indirizzo = it)) } }
        item { ProfileField("CAP", current.cap) { onChange(current.copy(cap = it)) } }
        item { ProfileField("Citta", current.citta) { onChange(current.copy(citta = it)) } }
        item { ProfileField("Provincia", current.provincia) { onChange(current.copy(provincia = it)) } }
        item { ProfileField("Paese", current.paese) { onChange(current.copy(paese = it)) } }
        item { ProfileField("Email", current.email) { onChange(current.copy(email = it)) } }
        item { ProfileField("PEC", current.pec) { onChange(current.copy(pec = it)) } }
        item { ProfileField("Telefono", current.telefono) { onChange(current.copy(telefono = it)) } }
        item { ProfileField("Sito web", current.sitoWeb) { onChange(current.copy(sitoWeb = it)) } }
        item { ProfileField("Codice SDI", current.codiceSdi) { onChange(current.copy(codiceSdi = it)) } }
        item {
            Button(onClick = onSave, enabled = !loading && !saving && current != original, modifier = Modifier.fillMaxWidth()) {
                if (saving) CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                else Text("Salva modifiche")
            }
        }
    }
}

@Composable
private fun ProfileField(label: String, value: String, onValueChange: (String) -> Unit) {
    OutlinedTextField(value = value, onValueChange = onValueChange, modifier = Modifier.fillMaxWidth(), label = { Text(label) })
}

@Composable
private fun SectionHeader(title: String, subtitle: String) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun EmptyCard(message: String) {
    Card(
        shape = RoundedCornerShape(22.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.3f)),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Text(message, modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun BrandMark() {
    Surface(
        modifier = Modifier.size(58.dp),
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.18f),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.35f))
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.linearGradient(
                        listOf(
                            MaterialTheme.colorScheme.primary.copy(alpha = 0.96f),
                            MaterialTheme.colorScheme.secondary.copy(alpha = 0.86f)
                        )
                    )
                ),
            contentAlignment = Alignment.Center
        ) {
            Text("H", color = MaterialTheme.colorScheme.onPrimary, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Black)
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(10.dp))
        Text(value.ifBlank { "-" }, fontWeight = FontWeight.Medium)
    }
}

private fun formatCurrency(value: Double?): String {
    return if (value == null) "-" else "EUR %.2f".format(Locale.ITALY, value)
}

@Preview(showBackground = true, showSystemUi = true)
@Composable
private fun AuthPreview() {
    HorygonTabletTheme {
        AuthScreen(
            authMode = AuthMode.Login,
            onModeChange = {},
            baseUrl = "https://app.horygon.com/",
            onBaseUrlChange = {},
            loginEmail = "tablet@horygon.com",
            onLoginEmailChange = {},
            loginPassword = "secret123",
            onLoginPasswordChange = {},
            registerEmail = "",
            onRegisterEmailChange = {},
            registerPassword = "",
            onRegisterPasswordChange = {},
            registerCompany = "",
            onRegisterCompanyChange = {},
            registerPhone = "",
            onRegisterPhoneChange = {},
            loading = false,
            onLogin = {},
            onRegister = {}
        )
    }
}
