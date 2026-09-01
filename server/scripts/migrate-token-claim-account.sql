-- The account a token claim lives in.
--
-- A bond token in a third party's hands is a claim on the trust, so it belongs
-- on the liability side next to the distributions and fees the trust already
-- owes. Token the trust holds itself is not a liability — a claim on yourself is
-- not a debt — so nothing is posted for treasury holdings.
INSERT INTO trust_accounts (account_code, account_name, account_type, sub_type, description)
VALUES
  ('2010', 'Token Claims Payable', 'liability', 'payable', 'Bond-backed token held outside the trust: a claim on the corpus, extinguished on exchange or burn')
ON CONFLICT (account_code) DO NOTHING;
