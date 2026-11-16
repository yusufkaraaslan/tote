package com.tote.mobile;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import okhttp3.*;
import org.json.JSONObject;

@CapacitorPlugin(name="ToteUpdater")
public class ToteUpdaterPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final OkHttpClient http = new OkHttpClient.Builder().connectTimeout(10,TimeUnit.SECONDS)
        .readTimeout(30,TimeUnit.SECONDS).callTimeout(15,TimeUnit.MINUTES).followRedirects(false).followSslRedirects(false).build();
    private volatile Call request;
    private volatile boolean canceled, busy;
    private volatile String phase = "idle", message = "", version = "";
    private volatile long received, total, deadline;
    private File root() { return new File(getContext().getFilesDir(),"updates"); }
    private File apk() { return new File(root(),"packages/artifact.apk"); }
    private File manifest() { return new File(root(),"manifest.json"); }
    private JSObject state() {
        JSObject result = new JSObject(); result.put("phase",phase); result.put("message",message);
        result.put("version",version); result.put("received",received); result.put("total",total); return result;
    }
    private synchronized boolean acquire() { if (busy) return false; busy = true; return true; }
    private synchronized void release() { busy = false; }
    private static String hex(byte[] bytes) { StringBuilder out = new StringBuilder(); for (byte b : bytes) out.append(String.format(java.util.Locale.ROOT,"%02x",b & 255)); return out.toString(); }
    private void checkCanceled() throws IOException { if (canceled || System.nanoTime() > deadline) throw new IOException("Download canceled or timed out. Try again."); }
    private byte[] fetch(String url, long limit, File file) throws Exception {
        for (int redirects=0; redirects<=3; redirects++) {
            checkCanceled();
            // The API is allowed only for the initial stable-release check.
            if (!url.equals("https://api.github.com/repos/yusufkaraaslan/tote/releases/latest")) UpdatePolicy.redirect(url);
            request = http.newCall(new Request.Builder().url(url).header("User-Agent","Tote-Android-updater").header("Accept-Encoding","identity").build());
            try (Response response = request.execute()) {
                if (response.isRedirect()) {
                    String location = response.header("Location");
                    if (location == null || redirects == 3) throw new IOException("Invalid update redirect");
                    url = java.net.URI.create(url).resolve(location).toString(); UpdatePolicy.redirect(url); continue;
                }
                if (response.code() != 200 || response.body() == null || !"identity".equals(response.header("Content-Encoding","identity"))) throw new IOException("Update download unavailable. Try again later.");
                ByteArrayOutputStream memory = file == null ? new ByteArrayOutputStream() : null;
                try (InputStream input = response.body().byteStream(); OutputStream out = file == null ? memory : new FileOutputStream(file)) {
                    byte[] buffer = new byte[32768]; long count = 0; int n;
                    while ((n = input.read(buffer)) != -1) { checkCanceled(); count += n; if (count > limit) throw new IOException("Update exceeds its size limit"); out.write(buffer,0,n); if (file != null) received = count; }
                    if (out instanceof FileOutputStream) ((FileOutputStream)out).getFD().sync();
                }
                return memory == null ? null : memory.toByteArray();
            } finally { request = null; }
        }
        throw new IOException("Too many update redirects");
    }
    private PackageInfo installed() throws Exception { return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(),PackageManager.GET_SIGNING_CERTIFICATES); }
    private JSONObject policy(JSONObject m) throws Exception {
        PackageInfo installed = installed();
        return UpdatePolicy.artifact(m,m.getString("version"),installed.versionName,installed.getLongVersionCode(),BuildConfig.UPDATE_PROTOCOL,Build.VERSION.SDK_INT);
    }
    private void verify(File file, JSONObject m) throws Exception {
        JSONObject a = policy(m);
        if (!file.isFile() || file.length() != UpdatePolicy.integer(a,"size")) throw new IOException("Update size changed. Download again.");
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) { byte[] b = new byte[32768]; int n; while ((n=in.read(b)) != -1) hash.update(b,0,n); }
        if (!hex(hash.digest()).equals(a.getString("sha256"))) throw new IOException("Update checksum failed. Download again.");
        PackageManager pm = getContext().getPackageManager();
        PackageInfo pkg = pm.getPackageArchiveInfo(file.getAbsolutePath(),PackageManager.GET_SIGNING_CERTIFICATES);
        if (pkg == null || !getContext().getPackageName().equals(pkg.packageName) || !m.getString("version").equals(pkg.versionName) ||
            pkg.getLongVersionCode() != UpdatePolicy.integer(m,"androidVersionCode") || pkg.applicationInfo == null ||
            (pkg.applicationInfo.flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0 || pkg.applicationInfo.minSdkVersion != UpdatePolicy.integer(m,"androidMinSdkVersion") ||
            pkg.signingInfo == null || pkg.signingInfo.hasMultipleSigners()) throw new IOException("Invalid production APK identity or version");
        Signature[] signers = pkg.signingInfo.getApkContentsSigners();
        if (signers.length != 1 || !hex(MessageDigest.getInstance("SHA-256").digest(signers[0].toByteArray())).equals(BuildConfig.UPDATE_CERTIFICATE))
            throw new IOException("APK is not signed by Tote's production key");
        PackageInfo current = installed();
        if (current.signingInfo == null || current.signingInfo.hasMultipleSigners()) throw new IOException("Installed app signing identity is incompatible");
        Signature[] old = current.signingInfo.getApkContentsSigners();
        boolean ancestor = false;
        for (Signature cert : pkg.signingInfo.getSigningCertificateHistory()) ancestor |= old.length == 1 && cert.equals(old[0]);
        if (!ancestor) throw new IOException("APK cannot preserve this installation's signing identity");
    }
    private JSONObject prepared() throws Exception {
        if (manifest().length() > 65536) throw new IOException("Invalid saved update metadata");
        JSONObject m = new JSONObject(new String(Files.readAllBytes(manifest().toPath()),java.nio.charset.StandardCharsets.UTF_8)); verify(apk(),m); return m;
    }
    @PluginMethod public void status(PluginCall call) {
        if (!acquire()) { call.resolve(state()); return; }
        worker.execute(() -> {
            try { JSONObject m = prepared(); version = m.getString("version"); phase = "ready"; message = ""; }
            catch (Exception ignored) { if (phase.equals("ready")) phase = "idle"; }
            finally { release(); call.resolve(state()); }
        });
    }
    @PluginMethod public void download(PluginCall call) {
        if (!acquire()) { call.reject("An update operation is already running"); return; }
        canceled = false; deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(15);
        phase = "downloading"; message = ""; received = total = 0;
        worker.execute(() -> {
            File partial = new File(root(),"packages/partial.apk");
            try {
                Files.createDirectories(partial.getParentFile().toPath());
                Files.deleteIfExists(partial.toPath()); Files.deleteIfExists(manifest().toPath()); Files.deleteIfExists(apk().toPath());
                JSONObject latest = new JSONObject(new String(fetch("https://api.github.com/repos/yusufkaraaslan/tote/releases/latest",262144,null),java.nio.charset.StandardCharsets.UTF_8));
                version = UpdateRelease.version(latest);
                if (!version.equals(call.getString("version"))) throw new IOException("The release changed. Check for updates again.");
                byte[] metadata = fetch(UpdatePolicy.assetURL(version,"release-manifest.json"),65536,null);
                JSONObject m = new JSONObject(new String(metadata,java.nio.charset.StandardCharsets.UTF_8));
                PackageInfo current = installed();
                JSONObject a = UpdatePolicy.artifact(m,version,current.versionName,current.getLongVersionCode(),BuildConfig.UPDATE_PROTOCOL,Build.VERSION.SDK_INT);
                total = UpdatePolicy.integer(a,"size");
                fetch(UpdatePolicy.assetURL(version,a.getString("name")),total,partial);
                verify(partial,m); checkCanceled();
                Files.move(partial.toPath(),apk().toPath(),StandardCopyOption.ATOMIC_MOVE);
                File temporary = new File(root(),"manifest.tmp");
                try (FileOutputStream out = new FileOutputStream(temporary)) { out.write(metadata); out.getFD().sync(); }
                Files.move(temporary.toPath(),manifest().toPath(),StandardCopyOption.ATOMIC_MOVE);
                phase = "ready"; call.resolve(state());
            } catch (Exception error) { phase = "error"; message = canceled ? "Download canceled. You can try again." : error.getMessage(); call.reject(message); }
            finally { partial.delete(); request = null; release(); }
        });
    }
    @PluginMethod public void cancel(PluginCall call) { canceled = true; Call active = request; if (active != null) active.cancel(); call.resolve(); }
    @PluginMethod public void install(PluginCall call) {
        if (!acquire()) { call.reject("An update operation is already running"); return; }
        worker.execute(() -> {
            try {
                prepared();
                getActivity().runOnUiThread(() -> {
                    try {
                        Intent intent;
                        if (!getContext().getPackageManager().canRequestPackageInstalls()) {
                            intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+getContext().getPackageName()));
                            call.getData().put("permissionStep",true);
                        } else {
                            Uri uri = FileProvider.getUriForFile(getContext(),getContext().getPackageName()+".updates",apk());
                            intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive")
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        }
                        startActivityForResult(call,intent,"installFinished");
                    } catch (Exception error) { release(); call.reject("Could not open Android's installer. Try again."); }
                });
            } catch (Exception error) { release(); call.reject(error.getMessage()); }
        });
    }
    @ActivityCallback private void installFinished(PluginCall call, ActivityResult result) {
        release();
        if (call == null) return;
        JSObject response = new JSObject(); response.put("permissionStep",call.getBoolean("permissionStep",false));
        response.put("allowed",getContext().getPackageManager().canRequestPackageInstalls()); call.resolve(response);
    }
    @Override protected void handleOnDestroy() { canceled = true; if (request != null) request.cancel(); worker.shutdownNow(); super.handleOnDestroy(); }
}
