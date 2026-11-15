-- Box was renamed to Boat; keep existing computers reconnecting to their sandbox.
UPDATE "computers" SET "kind" = 'boat' WHERE "kind" = 'box';
