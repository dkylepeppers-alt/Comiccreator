package com.dkylepeppers.comiccreator

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.prompt.GenerateContentRequest
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.ImagePart
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.prompt.generateTypedContentRequest
import com.google.mlkit.genai.schema.annotations.Generable
import com.google.mlkit.genai.schema.annotations.Guide
import java.time.Duration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

private const val MAX_IMAGE_EDGE = 1536
private const val MAX_INPUT_TOKENS = 3800
private const val MAX_OUTPUT_TOKENS = 512

@Generable("Structured metadata for one comic reference image")
data class ReferenceClassificationOutput(
    @Guide(
        description = "Visible reference subject",
        enumValues = ["character", "location", "interaction", "prop", "style"],
    )
    val subjectType: String,
    @Guide(
        description = "How the reference should be used",
        enumValues = [
            "identity", "appearance", "expression", "pose", "action", "establishing", "spatial",
            "landmark", "detail", "relationship", "design", "state", "rendering",
        ],
    )
    val use: String,
    @Guide(description = "Only stable character IDs visibly supported by the image", maxItems = 20)
    val characterIds: List<String>,
    @Guide(description = "A stable location ID visibly supported by the image, or null")
    val locationId: String?,
    @Guide(description = "Visible composition and appearance details")
    val facets: ReferenceFacetsOutput,
    @Guide(description = "Concise description of visible evidence")
    val description: String,
    @Guide(description = "Confidence scores from zero to one")
    val confidence: ReferenceConfidenceOutput,
)

@Generable("Visible reference facets")
data class ReferenceFacetsOutput(
    @Guide(
        description = "Camera framing",
        enumValues = [
            "extreme-close-up", "close-up", "medium-close-up", "medium", "three-quarter", "full-body",
            "wide", "establishing", "detail",
        ],
    )
    val framing: String? = null,
    @Guide(
        description = "Camera elevation",
        enumValues = ["eye-level", "high", "low", "overhead", "aerial", "ground-level"],
    )
    val cameraElevation: String? = null,
    @Guide(
        description = "Visible view direction",
        enumValues = [
            "front", "three-quarter-front", "left-profile", "right-profile", "three-quarter-rear", "rear",
        ],
    )
    val viewDirection: String? = null,
    @Guide(
        description = "Amount of character identity visible",
        enumValues = ["face", "upper-body", "full-body"],
    )
    val identityCoverage: String? = null,
    @Guide(description = "Interior, exterior, or threshold", enumValues = ["interior", "exterior", "threshold"])
    val spaceType: String? = null,
    @Guide(
        description = "Visible time of day",
        enumValues = ["dawn", "morning", "midday", "afternoon", "dusk", "night"],
    )
    val timeOfDay: String? = null,
)

@Generable("Classification confidence values")
data class ReferenceConfidenceOutput(
    @Guide(description = "Subject confidence", minimum = 0.0, maximum = 1.0)
    val subject: Double,
    @Guide(description = "Entity-link confidence", minimum = 0.0, maximum = 1.0)
    val links: Double,
    @Guide(description = "Reference-use confidence", minimum = 0.0, maximum = 1.0)
    val use: Double,
    @Guide(description = "Facet confidence", minimum = 0.0, maximum = 1.0)
    val facets: Double,
)

private class PromptBudgetException : Exception("Local classifier prompt exceeds its token budget")

@CapacitorPlugin(name = "LocalReferenceClassifier")
class LocalReferenceClassifierPlugin : Plugin() {
    private val model = Generation.getClient()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @PluginMethod
    fun getAvailability(call: PluginCall) {
        scope.launch {
            try {
                val result = JSObject()
                result.put("status", availabilityName(model.checkStatus()))
                call.resolve(result)
            } catch (error: Throwable) {
                reject(call, "Unable to check the local classifier", error, null)
            }
        }
    }

    @PluginMethod
    fun download(call: PluginCall) {
        scope.launch {
            try {
                var completed = false
                model.download().collect { status ->
                    when (status) {
                        is DownloadStatus.DownloadCompleted -> completed = true
                        is DownloadStatus.DownloadFailed -> throw status.e
                        else -> Unit
                    }
                }
                if (!completed) throw IllegalStateException("Local classifier download did not complete")
                call.resolve()
            } catch (error: Throwable) {
                reject(call, "Unable to download the local classifier", error, null)
            }
        }
    }

    @PluginMethod
    fun classify(call: PluginCall) {
        val dataUrl = call.getString("dataUrl")
        val prompt = call.getString("prompt")
        if (dataUrl == null || prompt == null) {
            call.reject("dataUrl and prompt are required", "invalid-input")
            return
        }
        scope.launch {
            var sourceBitmap: Bitmap? = null
            var requestBitmap: Bitmap? = null
            var mode = "text"
            try {
                sourceBitmap = decodeBitmap(dataUrl)
                requestBitmap = scaleBitmap(sourceBitmap)
                val baseRequest = configuredRequest(requestBitmap, prompt)
                val structuredAvailable = model.isStructuredOutputFeatureAvailable()
                if (structuredAvailable) {
                    mode = "structured"
                    try {
                        val typedRequest = generateTypedContentRequest(baseRequest, ReferenceClassificationOutput::class)
                        enforceBudget(model.countTokens(typedRequest).totalTokens)
                        val output = model.generateContent(typedRequest).candidates.firstOrNull()?.response
                            ?: throw IllegalStateException("Structured local classifier returned no response")
                        val result = JSObject()
                        result.put("text", output.toJson().toString())
                        result.put("mode", mode)
                        call.resolve(result)
                        return@launch
                    } catch (error: Throwable) {
                        if (error is GenAiException && !isStructuredFallbackError(error.errorCode)) throw error
                    }
                }
                mode = "text"
                enforceBudget(model.countTokens(baseRequest).totalTokens)
                val text = model.generateContent(baseRequest).candidates.firstOrNull()?.text
                if (text.isNullOrBlank()) throw IllegalStateException("Local classifier returned no text")
                val result = JSObject()
                result.put("text", text)
                result.put("mode", mode)
                call.resolve(result)
            } catch (error: Throwable) {
                reject(call, "Local image classification failed", error, mode)
            } finally {
                if (requestBitmap !== sourceBitmap) requestBitmap?.recycle()
                sourceBitmap?.recycle()
            }
        }
    }

    override fun handleOnDestroy() {
        scope.cancel()
        model.close()
        super.handleOnDestroy()
    }

    private fun configuredRequest(bitmap: Bitmap, prompt: String): GenerateContentRequest =
        GenerateContentRequest.Builder(ImagePart(bitmap), TextPart(prompt)).apply {
            temperature = 0.2f
            candidateCount = 1
            maxOutputTokens = MAX_OUTPUT_TOKENS
            enableThinking = false
        }.build()

    private fun enforceBudget(totalTokens: Int) {
        if (totalTokens > MAX_INPUT_TOKENS) throw PromptBudgetException()
    }

    private fun decodeBitmap(dataUrl: String): Bitmap {
        val separator = dataUrl.indexOf(',')
        if (separator < 0 || !dataUrl.substring(0, separator).contains(";base64")) {
            throw IllegalArgumentException("dataUrl must contain base64 image data")
        }
        val bytes = Base64.decode(dataUrl.substring(separator + 1), Base64.DEFAULT)
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            ?: throw IllegalArgumentException("Unable to decode reference image")
    }

    private fun scaleBitmap(bitmap: Bitmap): Bitmap {
        val longestEdge = maxOf(bitmap.width, bitmap.height)
        if (longestEdge <= MAX_IMAGE_EDGE) return bitmap
        val scale = MAX_IMAGE_EDGE.toDouble() / longestEdge.toDouble()
        return Bitmap.createScaledBitmap(
            bitmap,
            (bitmap.width * scale).toInt().coerceAtLeast(1),
            (bitmap.height * scale).toInt().coerceAtLeast(1),
            true,
        )
    }

    private fun reject(call: PluginCall, message: String, error: Throwable, mode: String?) {
        val genAiError = generateSequence(error) { it.cause }.filterIsInstance<GenAiException>().firstOrNull()
        val nativeCode = genAiError?.errorCode
        val data = JSObject()
        if (nativeCode != null) data.put("nativeCode", nativeCode)
        if (mode != null) data.put("mode", mode)
        val retryDelay = genAiError?.retryDelay
        if (retryDelay != null && retryDelay != Duration.ZERO && !retryDelay.isNegative) {
            data.put("retryDelayMs", retryDelay.toMillis())
        }
        call.reject(message, errorName(error, nativeCode), asException(error), data)
    }

    private fun errorName(error: Throwable, nativeCode: Int?): String = when {
        error is PromptBudgetException || nativeCode == GenAiException.ErrorCode.REQUEST_TOO_LARGE -> "request-too-large"
        nativeCode == GenAiException.ErrorCode.BACKGROUND_USE_BLOCKED -> "background-use-blocked"
        nativeCode == GenAiException.ErrorCode.BUSY -> "busy"
        nativeCode == GenAiException.ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED -> "quota-exceeded"
        nativeCode == GenAiException.ErrorCode.INVALID_INPUT_IMAGE || error is IllegalArgumentException -> "invalid-image"
        nativeCode == GenAiException.ErrorCode.NOT_AVAILABLE ||
            nativeCode == GenAiException.ErrorCode.NOT_SUPPORTED ||
            nativeCode == GenAiException.ErrorCode.AICORE_INCOMPATIBLE -> "not-available"
        isStructuredFallbackError(nativeCode) -> "structured-output-failed"
        else -> "inference-failed"
    }

    private fun isStructuredFallbackError(code: Int?): Boolean =
        code == GenAiException.ErrorCode.STRUCTURED_OUTPUT_REQUEST_ERROR ||
            code == GenAiException.ErrorCode.STRUCTURED_OUTPUT_RESPONSE_ERROR ||
            code == GenAiException.ErrorCode.STRUCTURED_OUTPUT_MAX_TOKENS_ERROR

    private fun availabilityName(status: Int?): String = when (status) {
        FeatureStatus.AVAILABLE -> "available"
        FeatureStatus.DOWNLOADABLE -> "downloadable"
        FeatureStatus.DOWNLOADING -> "downloading"
        else -> "unavailable"
    }

    private fun asException(error: Throwable): Exception = error as? Exception ?: Exception(error)
}

private fun ReferenceClassificationOutput.toJson(): JSONObject = JSONObject().apply {
    put("subjectType", subjectType)
    put("use", use)
    // Android's JSONObject stringifies raw Lists, so wrap in a JSONArray to emit a real JSON array.
    put("characterIds", JSONArray(characterIds))
    put("locationId", locationId ?: JSONObject.NULL)
    put("facets", facets.toJson())
    put("description", description)
    put("confidence", confidence.toJson())
}

private fun ReferenceFacetsOutput.toJson(): JSONObject = JSONObject().apply {
    framing?.let { put("framing", it) }
    cameraElevation?.let { put("cameraElevation", it) }
    viewDirection?.let { put("viewDirection", it) }
    identityCoverage?.let { put("identityCoverage", it) }
    spaceType?.let { put("spaceType", it) }
    timeOfDay?.let { put("timeOfDay", it) }
}

private fun ReferenceConfidenceOutput.toJson(): JSONObject = JSONObject().apply {
    put("subject", subject)
    put("links", links)
    put("use", use)
    put("facets", facets)
}
