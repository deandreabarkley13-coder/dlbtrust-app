<?php
header('Content-Type: application/json');

function fail($code, $message) {
    http_response_code($code);
    echo json_encode(['status' => 'failed', 'error' => $message]);
    exit;
}

$expectedKey = getenv('APACHE_HTTP_API_KEY') ?: '';
$headers = getallheaders();
$apiKey = '';
foreach ($headers as $name => $value) {
    if (strtolower($name) === 'x-api-key') {
        $apiKey = $value;
        break;
    }
}

if ($expectedKey !== '' && $apiKey !== $expectedKey) {
    fail(401, 'Invalid or missing x-api-key');
}

$body = file_get_contents('php://input');
if (!$body) {
    fail(400, 'Empty request body');
}

$data = json_decode($body, true);
if (!is_array($data)) {
    fail(400, 'Invalid JSON body');
}

$reference = $data['reference'] ?? 'UNKNOWN';
$amount = $data['amount'] ?? '0.00';
$currency = $data['currency'] ?? 'USD';
$cardholder = $data['cardholderName'] ?? '';
$last4 = $data['cardLast4'] ?? '';

$logLine = sprintf(
    "[%s] push-to-card reference=%s amount=%s %s cardholder=%s last4=%s ip=%s\n",
    gmdate('c'),
    $reference,
    $amount,
    $currency,
    $cardholder,
    $last4,
    $_SERVER['REMOTE_ADDR'] ?? 'unknown'
);
error_log($logLine, 3, '/var/log/apache2/push-to-card.log');

$txId = 'TX-' . bin2hex(random_bytes(8));
echo json_encode([
    'status' => 'submitted',
    'txId' => $txId,
    'reference' => $reference,
    'amount' => $amount,
    'currency' => $currency,
    'message' => 'Push-to-card accepted by self-hosted Apache HTTP endpoint'
]);
