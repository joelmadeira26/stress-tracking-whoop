package io.github.joelmadeira26.pulse;

import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

/**
 * Pulse keeps recording heart rate while the screen is off (a foreground service holds the
 * process). These overrides stop Android from pausing the web app's JavaScript in the background.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        keepAlive();
    }

    @Override
    public void onStop() {
        super.onStop();
        keepAlive();
    }

    private void keepAlive() {
        WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv != null) {
            wv.onResume();
            wv.resumeTimers();
        }
    }
}
