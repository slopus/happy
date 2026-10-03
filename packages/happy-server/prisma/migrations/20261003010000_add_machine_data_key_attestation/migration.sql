-- aplus-dev-studio specs/e2ee-machine-control-boundary R21: a customer client's attestation
-- of the machine key, boxed from its account or company key to itself.
ALTER TABLE "Machine" ADD COLUMN "dataKeyAttestation" BYTEA;
