package com.horygon.myapplication.data

import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Streaming

interface AppApiService {
    @POST("api/app/auth/register")
    suspend fun register(@Body body: RegisterRequest): AuthResponse

    @POST("api/app/auth/login")
    suspend fun login(@Body body: LoginRequest): AuthResponse

    @GET("api/app/profile")
    suspend fun getProfile(): ProfileResponse

    @PUT("api/app/profile")
    suspend fun updateProfile(@Body body: Map<String, @JvmSuppressWildcards String>): ProfileUpdateResponse

    @POST("api/app/chat")
    suspend fun chat(@Body body: ChatRequest): ChatResponse

    @GET("api/app/quotes")
    suspend fun getQuotes(): QuotesResponse

    @GET("api/app/quotes/{id}")
    suspend fun getQuote(@Path("id") id: Int): QuoteDetailResponse

    @Streaming
    @GET("api/app/quotes/{id}/pdf")
    suspend fun getQuotePdf(@Path("id") id: Int): Response<ResponseBody>
}
