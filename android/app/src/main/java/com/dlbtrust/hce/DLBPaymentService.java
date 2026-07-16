package com.dlbtrust.hce;

import android.nfc.cardemulation.HostApduService;
import android.os.Bundle;
import android.util.Log;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * DLB Trust HCE Payment Service
 *
 * Handles NFC contactless payment transactions at POS terminals.
 * When the phone is tapped on a terminal:
 * 1. Terminal sends SELECT APDU with our AID
 * 2. We respond with payment credentials (token from server)
 * 3. Terminal processes the payment
 * 4. We confirm settlement via server callback
 *
 * The payment token is pre-authorized by the server before the tap.
 * Token contains HMAC-SHA256 signed payment data with 5-minute expiry.
 */
public class DLBPaymentService extends HostApduService {
    private static final String TAG = "DLBPaymentService";

    // ISO 7816 status words
    private static final byte[] SW_OK = hexToBytes("9000");
    private static final byte[] SW_NOT_FOUND = hexToBytes("6A82");
    private static final byte[] SW_ERROR = hexToBytes("6F00");
    private static final byte[] SW_CONDITIONS_NOT_SATISFIED = hexToBytes("6985");

    // Our proprietary AID
    private static final byte[] DLB_AID = hexToBytes("D2760000850101");

    // SELECT APDU header (CLA=00, INS=A4, P1=04, P2=00)
    private static final byte SELECT_INS = (byte) 0xA4;

    // Current payment token (set by MainActivity before tap)
    private static String currentToken = null;
    private static String currentTxnId = null;
    private static double currentAmount = 0;
    private static String serverUrl = null;
    private static String adminToken = null;

    /**
     * Set payment credentials before tapping the terminal.
     * Called by MainActivity after getting authorization from server.
     */
    public static void setPaymentCredentials(String token, String txnId, double amount,
                                              String apiUrl, String authToken) {
        currentToken = token;
        currentTxnId = txnId;
        currentAmount = amount;
        serverUrl = apiUrl;
        adminToken = authToken;
        Log.i(TAG, "Payment credentials set: " + txnId + " $" + amount);
    }

    public static void clearCredentials() {
        currentToken = null;
        currentTxnId = null;
        currentAmount = 0;
    }

    public static boolean hasActivePayment() {
        return currentToken != null && currentTxnId != null;
    }

    @Override
    public byte[] processCommandApdu(byte[] commandApdu, Bundle extras) {
        if (commandApdu == null || commandApdu.length < 4) {
            return SW_ERROR;
        }

        byte ins = commandApdu[1];

        // Handle SELECT command
        if (ins == SELECT_INS) {
            return handleSelect(commandApdu);
        }

        // Handle GET DATA command (terminal requesting payment data)
        if (ins == (byte) 0xCA) {
            return handleGetData();
        }

        // Handle custom PROCESS command (terminal confirming payment)
        if (ins == (byte) 0xDA) {
            return handleProcess(commandApdu);
        }

        return SW_NOT_FOUND;
    }

    private byte[] handleSelect(byte[] apdu) {
        // Verify AID matches
        if (apdu.length < 5) return SW_ERROR;
        int aidLength = apdu[4] & 0xFF;
        if (apdu.length < 5 + aidLength) return SW_ERROR;

        byte[] receivedAid = Arrays.copyOfRange(apdu, 5, 5 + aidLength);
        if (!Arrays.equals(receivedAid, DLB_AID)) {
            Log.w(TAG, "AID mismatch");
            return SW_NOT_FOUND;
        }

        if (!hasActivePayment()) {
            Log.w(TAG, "No active payment — rejecting terminal");
            return SW_CONDITIONS_NOT_SATISFIED;
        }

        // Respond with app identifier + status
        String response = "DLB-TRUST-PAY|READY|" + currentTxnId;
        byte[] responseData = response.getBytes(StandardCharsets.UTF_8);
        return concat(responseData, SW_OK);
    }

    private byte[] handleGetData() {
        if (!hasActivePayment()) {
            return SW_CONDITIONS_NOT_SATISFIED;
        }

        // Send payment token to terminal
        // Format: TOKEN|TXN_ID|AMOUNT|CURRENCY
        String paymentData = currentToken + "|" + currentTxnId + "|" +
                String.format("%.2f", currentAmount) + "|USD";
        byte[] data = paymentData.getBytes(StandardCharsets.UTF_8);

        Log.i(TAG, "Sending payment data for " + currentTxnId);
        return concat(data, SW_OK);
    }

    private byte[] handleProcess(byte[] apdu) {
        if (!hasActivePayment()) {
            return SW_CONDITIONS_NOT_SATISFIED;
        }

        // Extract merchant info from terminal (if provided)
        String merchantInfo = "";
        if (apdu.length > 5) {
            int dataLen = apdu[4] & 0xFF;
            if (apdu.length >= 5 + dataLen) {
                merchantInfo = new String(
                    Arrays.copyOfRange(apdu, 5, 5 + dataLen),
                    StandardCharsets.UTF_8
                );
            }
        }

        // Confirm payment with server in background
        final String txnId = currentTxnId;
        final String merchant = merchantInfo;
        new Thread(() -> confirmPaymentWithServer(txnId, merchant)).start();

        // Respond with confirmation
        String confirmMsg = "CONFIRMED|" + currentTxnId;
        byte[] response = confirmMsg.getBytes(StandardCharsets.UTF_8);

        // Clear credentials after use
        clearCredentials();

        return concat(response, SW_OK);
    }

    private void confirmPaymentWithServer(String txnId, String merchantInfo) {
        if (serverUrl == null || adminToken == null) {
            Log.e(TAG, "Server URL or admin token not configured");
            return;
        }

        try {
            URL url = new URL(serverUrl + "/api/hce/process/" + txnId);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("x-admin-token", adminToken);
            conn.setDoOutput(true);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(15000);

            String body = "{\"merchant_name\":\"" + escapeJson(merchantInfo) + "\"}";
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body.getBytes(StandardCharsets.UTF_8));
            }

            int responseCode = conn.getResponseCode();
            BufferedReader reader = new BufferedReader(
                new InputStreamReader(
                    responseCode >= 200 && responseCode < 300
                        ? conn.getInputStream() : conn.getErrorStream()
                )
            );
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            reader.close();

            Log.i(TAG, "Server confirmation response (" + responseCode + "): " + sb.toString());
        } catch (Exception e) {
            Log.e(TAG, "Failed to confirm payment with server: " + e.getMessage());
        }
    }

    @Override
    public void onDeactivated(int reason) {
        String reasonStr = reason == DEACTIVATION_LINK_LOSS ? "link_loss" : "deselected";
        Log.i(TAG, "HCE deactivated: " + reasonStr);
    }

    // ─── Utility methods ──────────────────────────────────────────────────────

    private static byte[] hexToBytes(String hex) {
        int len = hex.length();
        byte[] data = new byte[len / 2];
        for (int i = 0; i < len; i += 2) {
            data[i / 2] = (byte) ((Character.digit(hex.charAt(i), 16) << 4)
                    + Character.digit(hex.charAt(i + 1), 16));
        }
        return data;
    }

    private static byte[] concat(byte[] a, byte[] b) {
        byte[] result = new byte[a.length + b.length];
        System.arraycopy(a, 0, result, 0, a.length);
        System.arraycopy(b, 0, result, a.length, b.length);
        return result;
    }

    private static String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r");
    }
}
