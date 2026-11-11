package com.horygon.myapplication.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

object ImagePayloadUtil {
    fun fromBitmap(bitmap: Bitmap): PreparedImagePayload {
        val scaled = scaleBitmap(bitmap, 1024)
        val jpeg = scaled.toJpegBytes()
        val base64 = Base64.encodeToString(jpeg, Base64.NO_WRAP)
        return PreparedImagePayload(
            dataUri = "data:image/jpeg;base64,$base64",
            previewBytes = jpeg
        )
    }

    fun fromUri(context: Context, uri: Uri): PreparedImagePayload {
        val decoded = decodeScaledBitmap(context, uri, 1024)
        return fromBitmap(decoded)
    }

    private fun decodeScaledBitmap(context: Context, uri: Uri, maxSide: Int): Bitmap {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(uri).use { input ->
            BitmapFactory.decodeStream(input, null, bounds)
        }

        var sampleSize = 1
        while (max(bounds.outWidth / sampleSize, bounds.outHeight / sampleSize) > maxSide * 2) {
            sampleSize *= 2
        }

        val options = BitmapFactory.Options().apply { inSampleSize = sampleSize }
        val bitmap = context.contentResolver.openInputStream(uri).use { input ->
            BitmapFactory.decodeStream(input, null, options)
        } ?: error("Immagine non leggibile")

        return scaleBitmap(bitmap, maxSide)
    }

    private fun scaleBitmap(bitmap: Bitmap, maxSide: Int): Bitmap {
        val currentMax = max(bitmap.width, bitmap.height)
        if (currentMax <= maxSide) return bitmap
        val scale = maxSide.toFloat() / currentMax.toFloat()
        val width = (bitmap.width * scale).roundToInt().coerceAtLeast(1)
        val height = (bitmap.height * scale).roundToInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(bitmap, width, height, true)
    }

    private fun Bitmap.toJpegBytes(): ByteArray {
        val output = ByteArrayOutputStream()
        compress(Bitmap.CompressFormat.JPEG, 84, output)
        return output.toByteArray()
    }
}
