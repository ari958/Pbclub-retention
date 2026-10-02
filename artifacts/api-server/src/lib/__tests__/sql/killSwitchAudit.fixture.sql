CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TABLE public.clubs(id uuid PRIMARY KEY, sms_kill_switch boolean);
INSERT INTO public.clubs VALUES ('00000000-0000-4000-8000-000000000001',true);