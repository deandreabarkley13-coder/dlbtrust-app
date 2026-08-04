-- Migrate SIT balances from 2-decimal cents to 6-decimal micro-SIT.
-- Run once before/after deploying code that treats SIT as 6 decimals.

BEGIN;

-- dapp_wallet_balances: scale SIT balance_cents by 10,000 (100 cents -> 1,000,000 micro-SIT)
UPDATE dapp_wallet_balances
SET balance_cents = balance_cents * 10000
WHERE asset = 'SIT';

-- dapp_wallet_transactions: scale SIT amount_cents by 10,000
UPDATE dapp_wallet_transactions
SET amount_cents = amount_cents * 10000
WHERE asset = 'SIT';

-- sovereign_token_holders: scale SIT balance_cents by 10,000
UPDATE sovereign_token_holders
SET balance_cents = balance_cents * 10000;

-- sovereign_ramp_orders: scale SIT amount_cents by 10,000 (all orders are SIT in this app)
UPDATE sovereign_ramp_orders
SET amount_cents = amount_cents * 10000;

COMMIT;
