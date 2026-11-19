-- KOVENIK address coordinates: smallest additive migration.
-- Two NULLABLE columns on addresses for the map pin a customer chose. Every existing row keeps all of its
-- data and simply gets NULL coordinates. No drops, no data changes, no defaults other than NULL.
-- DECIMAL(10,7) holds latitude (-90..90) and longitude (-180..180) to ~1 cm.
-- ALGORITHM=INSTANT makes this a metadata-only change (no table copy, no long lock); if the server cannot do it
-- as INSTANT the statement FAILS without changing anything, instead of silently rebuilding the table.
-- Re-runnable: scripts/apply-address-coordinates-migration.js skips what already exists.
-- Undo: scripts/sql/address_coordinates_phase1_down.sql
-- Statements are separated by a line containing only "-- ;;".

ALTER TABLE addresses ADD COLUMN latitude DECIMAL(10,7) NULL DEFAULT NULL, ALGORITHM=INSTANT;
-- ;;
ALTER TABLE addresses ADD COLUMN longitude DECIMAL(10,7) NULL DEFAULT NULL, ALGORITHM=INSTANT;
