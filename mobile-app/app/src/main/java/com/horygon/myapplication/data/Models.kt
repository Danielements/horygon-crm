package com.horygon.myapplication.data

data class SessionData(
    val baseUrl: String,
    val token: String,
    val customerId: Int,
    val email: String
)

data class CustomerDto(
    val id: Int,
    val email: String
)

data class AuthResponse(
    val token: String,
    val customer: CustomerDto
)

data class LoginRequest(
    val email: String,
    val password: String
)

data class RegisterRequest(
    val email: String,
    val password: String,
    val ragione_sociale: String? = null,
    val telefono: String? = null
)

data class ProfileDto(
    val ragione_sociale: String? = null,
    val piva: String? = null,
    val cf: String? = null,
    val indirizzo: String? = null,
    val cap: String? = null,
    val citta: String? = null,
    val provincia: String? = null,
    val paese: String? = null,
    val email: String? = null,
    val pec: String? = null,
    val telefono: String? = null,
    val sito_web: String? = null,
    val codice_sdi: String? = null
)

data class ProfileResponse(
    val email: String? = null,
    val profile: ProfileDto
)

data class ProfileUpdateResponse(
    val profile: ProfileDto
)

data class ChatOptionDto(
    val label: String,
    val value: String
)

data class ChatRequest(
    val text: String? = null,
    val imageBase64: String? = null
)

data class ChatResponse(
    val reply: String,
    val options: List<ChatOptionDto> = emptyList(),
    val quoteGenerated: Boolean = false
)

data class QuotesResponse(
    val quotes: List<QuoteSummaryDto> = emptyList()
)

data class QuoteSummaryDto(
    val id: Int,
    val codice: String,
    val data: String? = null,
    val imponibile: Double? = null,
    val iva: Double? = null,
    val totale: Double? = null,
    val stato: String? = null,
    val numRighe: Int? = null
)

data class QuoteDetailResponse(
    val quote: QuoteDetailDto
)

data class QuoteDetailDto(
    val id: Int,
    val codice: String,
    val data: String? = null,
    val imponibile: Double? = null,
    val iva: Double? = null,
    val totale: Double? = null,
    val stato: String? = null,
    val righe: List<QuoteLineDto> = emptyList()
)

data class QuoteLineDto(
    val descrizione: String? = null,
    val quantita: Double? = null,
    val prezzo_unitario: Double? = null,
    val totale_riga: Double? = null
)

data class ProfileForm(
    val ragioneSociale: String = "",
    val piva: String = "",
    val cf: String = "",
    val indirizzo: String = "",
    val cap: String = "",
    val citta: String = "",
    val provincia: String = "",
    val paese: String = "",
    val email: String = "",
    val pec: String = "",
    val telefono: String = "",
    val sitoWeb: String = "",
    val codiceSdi: String = ""
) {
    fun isIncomplete(): Boolean = piva.isBlank() || indirizzo.isBlank()

    fun diffFrom(original: ProfileForm): Map<String, String> {
        val changes = linkedMapOf<String, String>()
        fun putIfChanged(key: String, current: String, previous: String) {
            if (current != previous) changes[key] = current
        }
        putIfChanged("ragione_sociale", ragioneSociale, original.ragioneSociale)
        putIfChanged("piva", piva, original.piva)
        putIfChanged("cf", cf, original.cf)
        putIfChanged("indirizzo", indirizzo, original.indirizzo)
        putIfChanged("cap", cap, original.cap)
        putIfChanged("citta", citta, original.citta)
        putIfChanged("provincia", provincia, original.provincia)
        putIfChanged("paese", paese, original.paese)
        putIfChanged("email", email, original.email)
        putIfChanged("pec", pec, original.pec)
        putIfChanged("telefono", telefono, original.telefono)
        putIfChanged("sito_web", sitoWeb, original.sitoWeb)
        putIfChanged("codice_sdi", codiceSdi, original.codiceSdi)
        return changes
    }
}

data class UiChatMessage(
    val id: Long,
    val isUser: Boolean,
    val text: String? = null,
    val imageBytes: ByteArray? = null,
    val options: List<ChatOptionDto> = emptyList(),
    val quoteGenerated: Boolean = false,
    val isTyping: Boolean = false
)

data class PreparedImagePayload(
    val dataUri: String,
    val previewBytes: ByteArray
)
