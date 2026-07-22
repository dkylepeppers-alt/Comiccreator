package com.dkylepeppers.comiccreator;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.FutureCallback;
import com.google.common.util.concurrent.Futures;
import com.google.mlkit.genai.common.DownloadCallback;
import com.google.mlkit.genai.common.FeatureStatus;
import com.google.mlkit.genai.common.GenAiException;
import com.google.mlkit.genai.prompt.GenerateContentRequest;
import com.google.mlkit.genai.prompt.GenerateContentResponse;
import com.google.mlkit.genai.prompt.Generation;
import com.google.mlkit.genai.prompt.ImagePart;
import com.google.mlkit.genai.prompt.TextPart;
import com.google.mlkit.genai.prompt.java.GenerativeModelFutures;

@CapacitorPlugin(name = "LocalReferenceClassifier")
public class LocalReferenceClassifierPlugin extends Plugin {
    private final GenerativeModelFutures model = GenerativeModelFutures.from(Generation.INSTANCE.getClient());

    @PluginMethod
    public void getAvailability(PluginCall call) {
        Futures.addCallback(
            model.checkStatus(),
            new FutureCallback<Integer>() {
                @Override
                public void onSuccess(Integer status) {
                    JSObject result = new JSObject();
                    result.put("status", availabilityName(status));
                    call.resolve(result);
                }

                @Override
                public void onFailure(@NonNull Throwable error) {
                    call.reject("Unable to check the local classifier", error);
                }
            },
            ContextCompat.getMainExecutor(getContext())
        );
    }

    @PluginMethod
    public void download(PluginCall call) {
        Futures.addCallback(
            model.download(
                new DownloadCallback() {
                    @Override
                    public void onDownloadStarted(long bytes) {}

                    @Override
                    public void onDownloadProgress(long bytes) {}

                    @Override
                    public void onDownloadCompleted() {}

                    @Override
                    public void onDownloadFailed(@NonNull GenAiException error) {}
                }
            ),
            new FutureCallback<Void>() {
                @Override
                public void onSuccess(Void ignored) {
                    call.resolve();
                }

                @Override
                public void onFailure(@NonNull Throwable error) {
                    call.reject("Unable to download the local classifier", error);
                }
            },
            ContextCompat.getMainExecutor(getContext())
        );
    }

    @PluginMethod
    public void classify(PluginCall call) {
        String dataUrl = call.getString("dataUrl");
        String prompt = call.getString("prompt");
        if (dataUrl == null || prompt == null) {
            call.reject("dataUrl and prompt are required");
            return;
        }

        Bitmap bitmap;
        try {
            int separator = dataUrl.indexOf(',');
            if (separator < 0 || !dataUrl.substring(0, separator).contains(";base64")) {
                call.reject("dataUrl must contain base64 image data");
                return;
            }
            byte[] bytes = Base64.decode(dataUrl.substring(separator + 1), Base64.DEFAULT);
            bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (IllegalArgumentException error) {
            call.reject("Invalid base64 image data", error);
            return;
        }

        if (bitmap == null) {
            call.reject("Unable to decode reference image");
            return;
        }

        GenerateContentRequest request = new GenerateContentRequest.Builder(
            new ImagePart(bitmap),
            new TextPart(prompt)
        ).build();
        Futures.addCallback(
            model.generateContent(request),
            new FutureCallback<GenerateContentResponse>() {
                @Override
                public void onSuccess(GenerateContentResponse response) {
                    if (response.getCandidates().isEmpty()) {
                        call.reject("The local classifier returned no response");
                        return;
                    }
                    String text = response.getCandidates().get(0).getText();
                    if (text == null || text.trim().isEmpty()) {
                        call.reject("The local classifier returned no text");
                        return;
                    }
                    JSObject result = new JSObject();
                    result.put("text", text);
                    call.resolve(result);
                }

                @Override
                public void onFailure(@NonNull Throwable error) {
                    call.reject("Local image classification failed", error);
                }
            },
            ContextCompat.getMainExecutor(getContext())
        );
    }

    private static String availabilityName(Integer status) {
        if (status == null) return "unavailable";
        switch (status) {
            case FeatureStatus.AVAILABLE:
                return "available";
            case FeatureStatus.DOWNLOADABLE:
                return "downloadable";
            case FeatureStatus.DOWNLOADING:
                return "downloading";
            default:
                return "unavailable";
        }
    }
}
