-- ROLLBACK of address_coordinates_phase1.sql.
-- Drops only the two columns that migration added. All original address columns and rows are untouched.
-- The ONLY data lost is the coordinates saved after the migration (they exist nowhere else).
-- Run it with: node scripts/apply-address-coordinates-migration.js --rollback --apply
-- (the runner refuses if coordinates exist unless --confirm-data-loss is also passed).
-- Statements are separated by a line containing only "-- ;;".

ALTER TABLE addresses DROP COLUMN longitude, ALGORITHM=INSTANT;
-- ;;
ALTER TABLE addresses DROP COLUMN latitude, ALGORITHM=INSTANT;
