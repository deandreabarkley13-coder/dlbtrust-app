-- Add dedicated stablecoin asset account to the trust chart of accounts
INSERT INTO trust_accounts (account_code, account_name, account_type, sub_type, description)
VALUES ('1210', 'Stablecoin Backing Asset', 'asset', 'stablecoin', 'USDC/USDT/stablecoin backing asset on-chain')
ON CONFLICT (account_code) DO NOTHING;
