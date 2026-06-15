-- Create the default tenant database that Fineract expects.
-- The tenant store DB (fineract_tenants) is created by POSTGRES_DB env var;
-- this script creates the actual tenant database referenced in the tenant store.
SELECT 'CREATE DATABASE fineract_default'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'fineract_default')\gexec
