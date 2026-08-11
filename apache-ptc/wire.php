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

$reference = $data['reference'] ?? ($data['wire_id'] ?? 'UNKNOWN');
$amount = $data['amount_cents'] ?? '0';
$currency = $data['currency'] ?? 'USD';
$beneficiary = $data['beneficiary_name'] ?? '';
$routing = $data['beneficiary_routing'] ?? '';
$account = $data['beneficiary_account'] ?? '';

$logLine = sprintf(
    "[%s] wire reference=%s amount=%s %s beneficiary=%s routing=%s account=%s ip=%s\n",
    gmdate('c'),
    $reference,
    $amount,
    $currency,
    $beneficiary,
    $routing,
    substr($account, -4),
    $_SERVER['REMOTE_ADDR'] ?? 'unknown'
);
error_log($logLine, 3, '/var/log/apache2/wire-origination.log');

$referenceNumber = 'WIRE-' . strtoupper(bin2hex(random_bytes(6)));
echo json_encode([
    'status' => 'submitted',
    'referenceNumber' => $referenceNumber,
    'reference' => $reference,
    'amount_cents' => $amount,
    'currency' => $currency,
    'message' => 'Wire accepted by self-hosted Apache HTTP endpoint'
]);
