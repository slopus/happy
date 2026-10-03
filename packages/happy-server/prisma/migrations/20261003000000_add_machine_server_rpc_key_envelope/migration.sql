-- aplus-dev-studio specs/e2ee-machine-control-boundary R1: the server's own RPC
-- key (separate from the machine key), wrapped to the server service key.
ALTER TABLE "Machine" ADD COLUMN "serverRpcKeyEnvelope" BYTEA;
