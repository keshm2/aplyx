-- Close two cross-scope integrity gaps in the account layer.
--
-- The existing foreign keys only checked managed_aliases.id and
-- application_accounts.id independently. That allowed a valid id from a
-- different user, or a valid account from a different ATS family, to be
-- attached through a direct client write. Composite foreign keys make the
-- database enforce the ownership and family boundaries as well.

alter table public.managed_aliases
  add constraint managed_aliases_user_id_id_family_key
  unique (user_id, id, family);

alter table public.application_accounts
  add constraint application_accounts_user_id_id_family_key
  unique (user_id, id, ats_family);

do $$
begin
  if exists (
    select 1
    from public.application_accounts a
    left join public.managed_aliases m
      on m.user_id = a.user_id
     and m.id = a.managed_alias_id
     and m.family = a.ats_family
    where a.managed_alias_id is not null and m.id is null
  ) then
    raise exception
      'cannot add application account alias scope constraint: existing account has an alias owned by another user or ATS family';
  end if;

  if exists (
    select 1
    from public.apply_runs r
    join public.application_accounts a
      on a.user_id = r.user_id and a.id = r.account_id
    where r.account_id is not null and r.family <> a.ats_family
  ) then
    raise exception
      'cannot add apply run account family constraint: existing run references an account from another ATS family';
  end if;
end $$;

alter table public.application_accounts
  add constraint application_accounts_managed_alias_scope_fkey
  foreign key (user_id, managed_alias_id, ats_family)
  references public.managed_aliases (user_id, id, family);

alter table public.apply_runs
  add constraint apply_runs_user_id_account_id_family_fkey
  foreign key (user_id, account_id, family)
  references public.application_accounts (user_id, id, ats_family)
  on delete set null (account_id);
