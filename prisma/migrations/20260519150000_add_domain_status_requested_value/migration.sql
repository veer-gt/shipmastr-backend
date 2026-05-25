-- Add the storefront domain lifecycle value in its own committed migration.
-- PostgreSQL does not allow a newly added enum value to be used as a table
-- default until after the transaction that added it has committed.

ALTER TYPE "DomainStatus" ADD VALUE IF NOT EXISTS 'REQUESTED';
