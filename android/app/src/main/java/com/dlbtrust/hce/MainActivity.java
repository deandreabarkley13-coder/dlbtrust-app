package com.dlbtrust.hce;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.nfc.NfcAdapter;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * DLB Trust HCE Payment - Main Activity
 *
 * Manages:
 * - Server connection configuration
 * - Device registration with the DLB Trust backend
 * - Payment authorization (pre-tap)
 * - NFC readiness status
 * - Transaction history display
 */
public class MainActivity extends Activity {
    private static final String TAG = "DLBTrustPay";
    private static final String PREFS_NAME = "DLBTrustHCE";

    private NfcAdapter nfcAdapter;
    private ExecutorService executor;
    private Handler mainHandler;

    private String serverUrl;
    private String adminToken;
    private String deviceId;

    // UI elements
    private TextView statusText;
    private TextView nfcStatus;
    private TextView deviceInfo;
    private TextView paymentStatus;
    private EditText serverInput;
    private EditText tokenInput;
    private EditText amountInput;
    private EditText merchantInput;
    private Button connectBtn;
    private Button authorizeBtn;
    private Button registerBtn;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        executor = Executors.newSingleThreadExecutor();
        mainHandler = new Handler(Looper.getMainLooper());

        initViews();
        checkNfc();
        loadSettings();
    }

    private void initViews() {
        statusText = findViewById(R.id.statusText);
        nfcStatus = findViewById(R.id.nfcStatus);
        deviceInfo = findViewById(R.id.deviceInfo);
        paymentStatus = findViewById(R.id.paymentStatus);
        serverInput = findViewById(R.id.serverInput);
        tokenInput = findViewById(R.id.tokenInput);
        amountInput = findViewById(R.id.amountInput);
        merchantInput = findViewById(R.id.merchantInput);
        connectBtn = findViewById(R.id.connectBtn);
        authorizeBtn = findViewById(R.id.authorizeBtn);
        registerBtn = findViewById(R.id.registerBtn);

        connectBtn.setOnClickListener(v -> connectToServer());
        authorizeBtn.setOnClickListener(v -> authorizePayment());
        registerBtn.setOnClickListener(v -> registerDevice());
    }

    private void checkNfc() {
        nfcAdapter = NfcAdapter.getDefaultAdapter(this);
        if (nfcAdapter == null) {
            nfcStatus.setText("NFC: Not Available");
            nfcStatus.setTextColor(0xFFFF0000);
        } else if (!nfcAdapter.isEnabled()) {
            nfcStatus.setText("NFC: Disabled — Enable in Settings");
            nfcStatus.setTextColor(0xFFFF8800);
        } else {
            nfcStatus.setText("NFC: Ready");
            nfcStatus.setTextColor(0xFF00AA00);
        }
    }

    private void loadSettings() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        serverUrl = prefs.getString("server_url", "https://dlbtrust-app.fly.dev");
        adminToken = prefs.getString("admin_token", "");
        deviceId = prefs.getString("device_id", "");

        serverInput.setText(serverUrl);
        tokenInput.setText(adminToken);

        if (!deviceId.isEmpty()) {
            deviceInfo.setText("Device: " + deviceId);
            authorizeBtn.setEnabled(true);
        } else {
            deviceInfo.setText("Device: Not Registered");
            authorizeBtn.setEnabled(false);
        }
    }

    private void saveSettings() {
        SharedPreferences.Editor editor = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit();
        editor.putString("server_url", serverUrl);
        editor.putString("admin_token", adminToken);
        editor.putString("device_id", deviceId);
        editor.apply();
    }

    private void connectToServer() {
        serverUrl = serverInput.getText().toString().trim();
        adminToken = tokenInput.getText().toString().trim();

        if (serverUrl.isEmpty() || adminToken.isEmpty()) {
            toast("Enter server URL and admin token");
            return;
        }

        statusText.setText("Connecting...");
        connectBtn.setEnabled(false);

        executor.execute(() -> {
            try {
                String response = httpGet(serverUrl + "/api/hce/circuit-status");
                JSONObject json = new JSONObject(response);

                mainHandler.post(() -> {
                    connectBtn.setEnabled(true);
                    if (json.optBoolean("success")) {
                        statusText.setText("Connected to DLB Trust Server");
                        statusText.setTextColor(0xFF00AA00);
                        saveSettings();
                        registerBtn.setEnabled(true);
                        if (!deviceId.isEmpty()) authorizeBtn.setEnabled(true);
                    } else {
                        statusText.setText("Connection failed: " + json.optString("error"));
                        statusText.setTextColor(0xFFFF0000);
                    }
                });
            } catch (Exception e) {
                mainHandler.post(() -> {
                    connectBtn.setEnabled(true);
                    statusText.setText("Connection error: " + e.getMessage());
                    statusText.setTextColor(0xFFFF0000);
                });
            }
        });
    }

    private void registerDevice() {
        String deviceName = android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL;
        statusText.setText("Registering device...");

        executor.execute(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("device_name", deviceName);
                body.put("account_holder", "Trust Account Holder");
                body.put("platform", "android");
                body.put("app_version", "1.0.0");
                body.put("device_fingerprint", getDeviceFingerprint());

                String response = httpPost(serverUrl + "/api/hce/devices/register", body.toString());
                JSONObject json = new JSONObject(response);

                mainHandler.post(() -> {
                    if (json.optBoolean("success")) {
                        JSONObject data = json.optJSONObject("data");
                        deviceId = data != null ? data.optString("device_id") : "";
                        deviceInfo.setText("Device: " + deviceId);
                        statusText.setText("Device registered successfully");
                        statusText.setTextColor(0xFF00AA00);
                        authorizeBtn.setEnabled(true);
                        saveSettings();
                    } else {
                        statusText.setText("Registration failed: " + json.optString("error"));
                        statusText.setTextColor(0xFFFF0000);
                    }
                });
            } catch (Exception e) {
                mainHandler.post(() -> {
                    statusText.setText("Registration error: " + e.getMessage());
                    statusText.setTextColor(0xFFFF0000);
                });
            }
        });
    }

    private void authorizePayment() {
        String amountStr = amountInput.getText().toString().trim();
        String merchant = merchantInput.getText().toString().trim();

        if (amountStr.isEmpty()) {
            toast("Enter payment amount");
            return;
        }

        double amount;
        try {
            amount = Double.parseDouble(amountStr);
        } catch (NumberFormatException e) {
            toast("Invalid amount");
            return;
        }

        if (amount < 1 || amount > 500000) {
            toast("Amount must be $1 - $500,000");
            return;
        }

        paymentStatus.setText("Authorizing...");
        authorizeBtn.setEnabled(false);

        executor.execute(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("device_id", deviceId);
                body.put("amount", amount);
                if (!merchant.isEmpty()) body.put("merchant_name", merchant);

                String response = httpPost(serverUrl + "/api/hce/authorize", body.toString());
                JSONObject json = new JSONObject(response);

                mainHandler.post(() -> {
                    authorizeBtn.setEnabled(true);
                    if (json.optBoolean("success")) {
                        JSONObject data = json.optJSONObject("data");
                        if (data != null) {
                            String token = data.optString("token");
                            String txnId = data.optString("txn_id");
                            String authCode = data.optString("authorization_code");
                            boolean requiresApproval = data.optBoolean("requires_approval");

                            if (requiresApproval) {
                                paymentStatus.setText("Pending approval (tier: " +
                                    data.optString("approval_tier") + ").\nAuth: " + authCode);
                                paymentStatus.setTextColor(0xFFFF8800);
                            } else {
                                // Set credentials for HCE service
                                DLBPaymentService.setPaymentCredentials(
                                    token, txnId, amount, serverUrl, adminToken
                                );
                                paymentStatus.setText("READY TO TAP\n" +
                                    "Txn: " + txnId + "\n" +
                                    "Auth: " + authCode + "\n" +
                                    "Amount: $" + String.format("%.2f", amount) + "\n" +
                                    "Tap your phone on the terminal now.");
                                paymentStatus.setTextColor(0xFF00AA00);
                            }
                        }
                    } else {
                        paymentStatus.setText("Authorization failed: " + json.optString("error"));
                        paymentStatus.setTextColor(0xFFFF0000);
                    }
                });
            } catch (Exception e) {
                mainHandler.post(() -> {
                    authorizeBtn.setEnabled(true);
                    paymentStatus.setText("Error: " + e.getMessage());
                    paymentStatus.setTextColor(0xFFFF0000);
                });
            }
        });
    }

    private String getDeviceFingerprint() {
        return android.os.Build.FINGERPRINT + "|" +
               android.os.Build.SERIAL + "|" +
               android.os.Build.BOARD;
    }

    // ─── HTTP Helpers ─────────────────────────────────────────────────────────

    private String httpGet(String urlStr) throws Exception {
        URL url = new URL(urlStr);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("GET");
        conn.setRequestProperty("x-admin-token", adminToken);
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(15000);

        BufferedReader reader = new BufferedReader(
            new InputStreamReader(conn.getInputStream())
        );
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) sb.append(line);
        reader.close();
        return sb.toString();
    }

    private String httpPost(String urlStr, String jsonBody) throws Exception {
        URL url = new URL(urlStr);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("x-admin-token", adminToken);
        conn.setDoOutput(true);
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(15000);

        try (OutputStream os = conn.getOutputStream()) {
            os.write(jsonBody.getBytes(StandardCharsets.UTF_8));
        }

        int code = conn.getResponseCode();
        BufferedReader reader = new BufferedReader(
            new InputStreamReader(
                code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream()
            )
        );
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) sb.append(line);
        reader.close();
        return sb.toString();
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onResume() {
        super.onResume();
        checkNfc();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (executor != null) executor.shutdown();
    }
}
