DO $$
DECLARE result jsonb; n integer;
BEGIN
  IF (SELECT count(*) FROM sms_kill_switch_audit) <> 0 THEN RAISE EXCEPTION 'Migration must not backfill audit'; END IF;
  IF NOT (SELECT sms_kill_switch FROM clubs) THEN RAISE EXCEPTION 'Migration changed kill switch'; END IF;
  result := retention_set_kill_switch('00000000-0000-4000-8000-000000000001',false,'Offline operator','request-1');
  IF (result->>'enabled')::boolean OR NOT (result->>'old_value')::boolean THEN RAISE EXCEPTION 'Incorrect values'; END IF;
  IF NOT EXISTS (SELECT 1 FROM sms_kill_switch_audit WHERE actor='Offline operator'
    AND actor_identity_type='operator_label' AND request_id='request-1'
    AND old_value=true AND new_value=false AND changed_at IS NOT NULL) THEN RAISE EXCEPTION 'Missing audit details'; END IF;
  PERFORM retention_set_kill_switch('00000000-0000-4000-8000-000000000001',true,NULL,'request-2');
  IF NOT EXISTS (SELECT 1 FROM sms_kill_switch_audit WHERE actor_identity_type='unidentified' AND old_value=false AND new_value=true)
    THEN RAISE EXCEPTION 'Unidentified safety pause must be recorded honestly'; END IF;
  IF has_function_privilege('anon','retention_set_kill_switch(uuid,boolean,text,text)','EXECUTE')
    OR has_table_privilege('service_role','sms_kill_switch_audit','DELETE')
    THEN RAISE EXCEPTION 'Unsafe audit permissions'; END IF;
END;
$$;
CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Offline injected audit failure'; END;
$$;
CREATE TRIGGER reject_audit BEFORE INSERT ON sms_kill_switch_audit FOR EACH ROW EXECUTE FUNCTION reject_audit();
DO $$
BEGIN
  BEGIN
    PERFORM retention_set_kill_switch('00000000-0000-4000-8000-000000000001',false,'Offline operator');
    RAISE EXCEPTION 'Expected audit failure';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%Offline injected audit failure%' THEN RAISE; END IF;
  END;
  IF NOT (SELECT sms_kill_switch FROM clubs) OR (SELECT count(*) FROM sms_kill_switch_audit) <> 2
    THEN RAISE EXCEPTION 'Audit failure must roll back flag and history'; END IF;
END;
$$;