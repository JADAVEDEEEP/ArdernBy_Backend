-- OPTIONAL hardening for audit_logs. Not applied automatically.
--
-- The application never updates or deletes audit rows (it has no code path for
-- that). These triggers additionally make the DATABASE refuse UPDATE/DELETE on
-- audit_logs, so even a bug or a stolen app login cannot quietly rewrite
-- history. They do NOT stop someone with admin rights on the database itself
-- (who can drop the triggers) - for real tamper resistance, also copy the log
-- to storage the application cannot write to.
--
-- Needs the TRIGGER privilege. Check with your provider before applying.

DROP TRIGGER IF EXISTS audit_logs_no_update;
DROP TRIGGER IF EXISTS audit_logs_no_delete;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';

CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';
