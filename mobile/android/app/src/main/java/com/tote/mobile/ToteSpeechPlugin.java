package com.tote.mobile;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.util.ArrayList;
import java.util.Locale;

@CapacitorPlugin(name = "ToteSpeech", permissions = {
    @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
})
public class ToteSpeechPlugin extends Plugin {
    private SpeechRecognizer recognizer;
    private PluginCall pending;
    private boolean stopping;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable timeout = () -> fail("Speech recognition timed out. Try a shorter recording.");

    @PluginMethod public void start(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (pending != null) { call.reject("A recording is already in progress."); return; }
            pending = call;
            if (getPermissionState("microphone") != PermissionState.GRANTED) {
                requestPermissionForAlias("microphone", call, "microphoneResult");
            } else begin(call);
        });
    }
    @PermissionCallback private void microphoneResult(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (pending != call) return; // canceled while the permission sheet was open
            if (getPermissionState("microphone") != PermissionState.GRANTED) {
                fail("Microphone permission was denied. You can still type or use keyboard dictation."); return;
            }
            begin(call);
        });
    }
    private void begin(PluginCall call) {
        stopping = false;
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) { fail("No speech recognition service is installed. Use keyboard dictation or enable a speech service in Android settings."); return; }
        try {
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) { if (pending != call) return; state(true, null); }
                @Override public void onBeginningOfSpeech() { if (pending != call) return; state(true, null); }
                @Override public void onRmsChanged(float rms) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() { if (pending != call) return; stopping = true; state(false, null); main.removeCallbacks(timeout); main.postDelayed(timeout, 15000); }
                @Override public void onError(int error) {
                    if (pending != call) return;
                    String message = switch (error) {
                        case SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech recognized. Please try again.";
                        case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission is required.";
                        case SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Speech service could not connect. Check your network.";
                        case SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Speech service is busy. Please try again.";
                        default -> "Speech recognition failed (" + error + "). Please try again.";
                    };
                    fail(message);
                }
                @Override public void onResults(Bundle results) {
                    if (pending != call) return;
                    String text = transcript(results);
                    PluginCall done = pending; pending = null; cleanup();
                    if (done != null) { JSObject result = new JSObject(); result.put("text", text); done.resolve(result); }
                }
                @Override public void onPartialResults(Bundle results) { if (pending != call) return; state(!stopping, transcript(results)); }
                @Override public void onEvent(int type, Bundle params) {}
            });
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag());
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            recognizer.startListening(intent);
            main.postDelayed(timeout, 90000);
        } catch (Exception e) { fail("Could not start speech recognition: " + e.getMessage()); }
    }
    private String transcript(Bundle results) {
        ArrayList<String> texts = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return texts == null || texts.isEmpty() ? "" : texts.get(0);
    }
    private void state(boolean listening, String text) {
        if (pending == null) return;
        JSObject event = new JSObject(); event.put("listening", listening); if (text != null) event.put("text", text);
        notifyListeners("state", event);
    }
    @PluginMethod public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (recognizer == null || pending == null) { call.reject("No recording is in progress."); return; }
            stopping = true; recognizer.stopListening(); state(false, null); main.removeCallbacks(timeout); main.postDelayed(timeout, 15000); call.resolve();
        });
    }
    @PluginMethod public void cancel(PluginCall call) { getActivity().runOnUiThread(() -> { fail("Recording canceled."); call.resolve(); }); }
    private void cleanup() {
        main.removeCallbacks(timeout);
        SpeechRecognizer old = recognizer; recognizer = null;
        if (old != null) { old.cancel(); old.destroy(); }
    }
    private void fail(String message) { PluginCall done = pending; pending = null; cleanup(); if (done != null) done.reject(message); }
    @Override protected void handleOnStop() { if (recognizer != null) main.post(() -> fail("Recording stopped while app was in the background.")); }
    @Override protected void handleOnDestroy() { main.post(() -> fail("App closed.")); }
}
