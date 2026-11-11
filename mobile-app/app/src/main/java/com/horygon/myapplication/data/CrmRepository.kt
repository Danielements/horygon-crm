package com.horygon.myapplication.data

import android.content.Context
import android.net.Uri
import androidx.core.content.FileProvider
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import org.json.JSONObject
import retrofit2.HttpException
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException

class CrmRepository {
    private val moshi = Moshi.Builder()
        .add(KotlinJsonAdapterFactory())
        .build()

    @Volatile
    private var cachedApi: Pair<String, AppApiService>? = null

    suspend fun login(baseUrl: String, email: String, password: String): SessionData = withContext(Dispatchers.IO) {
        if (email.trim().isBlank()) throw AppException("Inserisci l'email")
        if (password.length < 6) throw AppException("La password deve avere almeno 6 caratteri")
        val normalizedBaseUrl = normalizeBaseUrl(baseUrl)
        try {
            val response = createApi(normalizedBaseUrl, null).login(
                LoginRequest(email = email.trim(), password = password)
            )
            SessionData(
                baseUrl = normalizedBaseUrl,
                token = response.token,
                customerId = response.customer.id,
                email = response.customer.email
            )
        } catch (error: Throwable) {
            throw mapError(error)
        }
    }

    suspend fun register(
        baseUrl: String,
        email: String,
        password: String,
        ragioneSociale: String,
        telefono: String
    ): SessionData = withContext(Dispatchers.IO) {
        if (email.trim().isBlank()) throw AppException("Inserisci l'email")
        if (password.length < 6) throw AppException("La password deve avere almeno 6 caratteri")
        val normalizedBaseUrl = normalizeBaseUrl(baseUrl)
        try {
            val response = createApi(normalizedBaseUrl, null).register(
                RegisterRequest(
                    email = email.trim(),
                    password = password,
                    ragione_sociale = ragioneSociale.trim().ifBlank { null },
                    telefono = telefono.trim().ifBlank { null }
                )
            )
            SessionData(
                baseUrl = normalizedBaseUrl,
                token = response.token,
                customerId = response.customer.id,
                email = response.customer.email
            )
        } catch (error: Throwable) {
            throw mapError(error)
        }
    }

    suspend fun fetchProfile(session: SessionData): ProfileForm = withContext(Dispatchers.IO) {
        try {
            createApi(session.baseUrl, session.token).getProfile().toProfileForm()
        } catch (error: Throwable) {
            throw mapError(error)
        }
    }

    suspend fun updateProfile(
        session: SessionData,
        original: ProfileForm,
        current: ProfileForm
    ): ProfileForm = withContext(Dispatchers.IO) {
        val changes = current.diffFrom(original)
        if (changes.isEmpty()) return@withContext current
        try {
            val response = createApi(session.baseUrl, session.token).updateProfile(changes)
            current.merge(response.profile)
        } catch (error: Throwable) {
            throw mapError(error)
        }
    }

    suspend fun fetchQuotes(session: SessionData): List<QuoteSummaryDto> = withContext(Dispatchers.IO) {
        try {
            createApi(session.baseUrl, session.token).getQuotes().quotes
        } catch (error: Throwable) {
            throw mapError(error)
        }
    }

    suspend fun fetchQuoteDetail(session: SessionData, quoteId: Int): QuoteDetailDto = withContext(Dispatchers.IO) {
        try {
            createApi(session.baseUrl, session.token).getQuote(quoteId).quote
        } catch (error: Throwable) {
            throw mapError(error)
        }
    }

    suspend fun sendChat(session: SessionData, text: String? = null, imageBase64: String? = null): ChatResponse =
        withContext(Dispatchers.IO) {
            if (text.isNullOrBlank() && imageBase64.isNullOrBlank()) {
                throw AppException("Inserisci un messaggio o allega una foto")
            }
            try {
                createApi(session.baseUrl, session.token).chat(
                    ChatRequest(
                        text = text?.trim()?.ifBlank { null },
                        imageBase64 = imageBase64?.ifBlank { null }
                    )
                )
            } catch (error: Throwable) {
                throw mapError(error)
            }
        }

    suspend fun downloadQuotePdf(context: Context, session: SessionData, quoteId: Int): Uri = withContext(Dispatchers.IO) {
        try {
            val response = createApi(session.baseUrl, session.token).getQuotePdf(quoteId)
            if (!response.isSuccessful) {
                throw HttpException(response)
            }
            val body = response.body() ?: throw AppException("PDF non disponibile")
            val target = File(context.cacheDir, "preventivo-$quoteId.pdf")
            target.outputStream().use { output ->
                body.byteStream().use { input -> input.copyTo(output) }
            }
            FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                target
            )
        } catch (error: Throwable) {
            throw mapError(error)
        }
    }

    private fun createApi(baseUrl: String, token: String?): AppApiService {
        val key = "$baseUrl|${token.orEmpty()}"
        val cached = cachedApi
        if (cached != null && cached.first == key) return cached.second

        val authInterceptor = Interceptor { chain ->
            val requestBuilder = chain.request().newBuilder()
            if (!token.isNullOrBlank()) {
                requestBuilder.addHeader("Authorization", "Bearer $token")
            }
            chain.proceed(requestBuilder.build())
        }

        val client = OkHttpClient.Builder()
            .addInterceptor(authInterceptor)
            .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .callTimeout(70, TimeUnit.SECONDS)
            .build()

        val api = Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(client)
            .addConverterFactory(MoshiConverterFactory.create(moshi))
            .build()
            .create(AppApiService::class.java)

        cachedApi = key to api
        return api
    }

    private fun mapError(error: Throwable): Throwable {
        return when (error) {
            is UnauthorizedException -> error
            is AppException -> error
            is HttpException -> {
                val code = error.code()
                val body = runCatching { error.response()?.errorBody()?.string() }.getOrNull().orEmpty()
                val serverMessage = runCatching { JSONObject(body).optString("error") }.getOrNull().orEmpty()
                when (code) {
                    401 -> UnauthorizedException(serverMessage.ifBlank { "Sessione scaduta, effettua di nuovo l'accesso." })
                    404 -> AppException(serverMessage.ifBlank { "Risorsa non trovata." })
                    409 -> AppException(serverMessage.ifBlank { "Conflitto nei dati inviati." })
                    500 -> AppException(serverMessage.ifBlank { "Errore interno del server." })
                    else -> AppException(serverMessage.ifBlank { "Errore HTTP $code" })
                }
            }
            is IOException -> AppException("Connessione non disponibile. Controlla rete e riprova.")
            is SSLException -> AppException("Errore SSL/TLS nella connessione al server.")
            else -> AppException(error.message ?: "Errore imprevisto")
        }
    }

    private fun normalizeBaseUrl(value: String): String {
        var normalized = value.trim()
        if (normalized.isBlank()) normalized = DEFAULT_BASE_URL
        if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
            normalized = "https://$normalized"
        }
        normalized = normalized.trimEnd('/')
        val apiIndex = normalized.indexOf("/api/app", ignoreCase = true)
        if (apiIndex >= 0) {
            normalized = normalized.substring(0, apiIndex)
        }
        return "$normalized/"
    }

    companion object {
        private const val DEFAULT_BASE_URL = "https://app.horygon.com/"
    }
}

private fun ProfileResponse.toProfileForm(): ProfileForm {
    return ProfileForm(
        ragioneSociale = profile.ragione_sociale.orEmpty(),
        piva = profile.piva.orEmpty(),
        cf = profile.cf.orEmpty(),
        indirizzo = profile.indirizzo.orEmpty(),
        cap = profile.cap.orEmpty(),
        citta = profile.citta.orEmpty(),
        provincia = profile.provincia.orEmpty(),
        paese = profile.paese.orEmpty(),
        email = profile.email ?: email.orEmpty(),
        pec = profile.pec.orEmpty(),
        telefono = profile.telefono.orEmpty(),
        sitoWeb = profile.sito_web.orEmpty(),
        codiceSdi = profile.codice_sdi.orEmpty()
    )
}

private fun ProfileForm.merge(dto: ProfileDto): ProfileForm {
    return copy(
        ragioneSociale = dto.ragione_sociale ?: ragioneSociale,
        piva = dto.piva ?: piva,
        cf = dto.cf ?: cf,
        indirizzo = dto.indirizzo ?: indirizzo,
        cap = dto.cap ?: cap,
        citta = dto.citta ?: citta,
        provincia = dto.provincia ?: provincia,
        paese = dto.paese ?: paese,
        email = dto.email ?: email,
        pec = dto.pec ?: pec,
        telefono = dto.telefono ?: telefono,
        sitoWeb = dto.sito_web ?: sitoWeb,
        codiceSdi = dto.codice_sdi ?: codiceSdi
    )
}

class AppException(message: String) : Exception(message)
class UnauthorizedException(message: String) : Exception(message)
