-- Drops the forwarding-based inbox pipeline (migrations 0005/0006),
-- superseded by the hosted-only IMAP design (0007-0009) before either
-- table ever held real user data; confirmed empty (all rows created
-- during this build were test rows, cleaned up live). The
-- inbound-email Edge Function was already deleted
-- (`supabase functions delete inbound-email`); this removes the schema
-- it and the per-user forwarding-address design depended on.

drop table if exists public.inbound_emails;
drop table if exists public.mail_usernames;
