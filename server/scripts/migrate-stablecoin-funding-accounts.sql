-- Accounts the USDC funding routes post against.
--
-- 1215 holds dollars that have left the bank for a venue but have not arrived
-- on-chain yet, so a funded-but-undelivered purchase is visible as exactly
-- that. 1216 holds the XLM an order-book swap gives up, since a swap spends
-- tokens rather than cash and must not relieve the USD transit account.
INSERT INTO trust_accounts (account_code, account_name, account_type, sub_type, description)
VALUES
  ('1215', 'USDC Purchases In Transit', 'asset', 'cash', 'USD sent to a funding venue, not yet received as USDC on-chain'),
  ('1216', 'Digital Asset - XLM', 'asset', 'stablecoin', 'Stellar lumens held by the distributor for reserves, fees and swaps')
ON CONFLICT (account_code) DO NOTHING;
