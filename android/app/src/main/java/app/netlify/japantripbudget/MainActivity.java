package app.netlify.japantripbudget;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * The whole app: a full-screen WebView showing the live site, so it always has the
 * latest data and features. The page talks to {@link Bridge} (window.AndroidBridge)
 * for the things a WebView can't do on its own: saving downloads and printing.
 */
public class MainActivity extends Activity {

    static final String HOME = "https://japan-trip-budget.netlify.app/";
    static final String HOST = "japan-trip-budget.netlify.app";

    static final String OFFLINE_PAGE =
            "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
            + "<body style='font-family:sans-serif;background:#faf7f2;color:#1f1b16;text-align:center;padding:64px 24px'>"
            + "<div style='width:56px;height:56px;border-radius:50%;background:#bc002d;margin:0 auto 24px'></div>"
            + "<h2>No connection</h2><p>The trip tracker needs the internet to load and sync.</p>"
            + "<p><a href='" + HOME + "' style='display:inline-block;margin-top:12px;padding:12px 20px;"
            + "border-radius:8px;background:#bc002d;color:#fff;text-decoration:none'>Try again</a></p></body>";

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // the page remembers your name in localStorage
        settings.setUserAgentString(settings.getUserAgentString() + " JapanTripApp/" + BuildConfig.VERSION_NAME);

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.setWebChromeClient(new WebChromeClient()); // shows the page's confirm() dialogs
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (HOST.equals(url.getHost())) return false;
                // Links to other sites (e.g. GitHub) open in the phone's browser.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (ActivityNotFoundException ignored) {
                    // nothing can open it
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    view.loadDataWithBaseURL(null, OFFLINE_PAGE, "text/html", "utf-8", null);
                }
            }
        });

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(HOME);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack(); // e.g. from the journal back to the budget page
        } else {
            super.onBackPressed();
        }
    }

    private void toast(String message) {
        runOnUiThread(() -> Toast.makeText(this, message, Toast.LENGTH_LONG).show());
    }

    /** Called from the page's JavaScript as window.AndroidBridge. */
    class Bridge {

        /** Saves an export (CSV, Markdown, JSON backup) to the phone's Downloads folder. */
        @JavascriptInterface
        public void saveFile(String name, String text, String mimeType) {
            byte[] data = text.getBytes(StandardCharsets.UTF_8);
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentResolver resolver = getContentResolver();
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                    values.put(MediaStore.Downloads.IS_PENDING, 1);
                    Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) throw new IllegalStateException("Couldn't create the file");
                    try (OutputStream out = resolver.openOutputStream(uri)) {
                        out.write(data);
                    }
                    values.clear();
                    values.put(MediaStore.Downloads.IS_PENDING, 0);
                    resolver.update(uri, values, null, null);
                    toast("Saved to Downloads: " + name);
                } else {
                    // Android 8–9: the app's own Downloads folder, which needs no permission.
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    File file = new File(dir, name);
                    try (OutputStream out = new FileOutputStream(file)) {
                        out.write(data);
                    }
                    toast("Saved to " + file.getAbsolutePath());
                }
            } catch (Exception e) {
                toast("Couldn't save " + name + ": " + e.getMessage());
            }
        }

        /** Opens Android's print dialog for the current page (print or save as PDF). */
        @JavascriptInterface
        public void print(String jobName) {
            runOnUiThread(() -> {
                PrintManager printManager = (PrintManager) getSystemService(PRINT_SERVICE);
                printManager.print(jobName, web.createPrintDocumentAdapter(jobName), null);
            });
        }
    }
}
