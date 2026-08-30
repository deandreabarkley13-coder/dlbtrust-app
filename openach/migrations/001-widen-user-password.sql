-- OpenACH hashes user passwords with hash_hmac(sha256) (64 hex chars) but its
-- postgresql schema still declares user_password as varchar(50), so creating a
-- user fails with "value too long for type character varying(50)". SQLite (the
-- upstream default) ignores the declared width, which is why the schema shipped
-- this way.
ALTER TABLE "user" ALTER COLUMN user_password TYPE character varying(128);
