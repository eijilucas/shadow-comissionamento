-- ============================================================================
-- Corrige: apagar um membro com vendas quebrava (FK violation).
--
-- Reproduzido em teste de ponta a ponta: um membro com vendas registradas
-- não conseguia ser apagado -- nem pelo botão "Excluir" do painel
-- (delete-member), nem pelo evento discounts/delete da Shopify
-- (shopify-webhook), nem por um DELETE direto.
--
-- Causa: `delete from members where id = ...` dispara o cascade
-- `on delete cascade` de `sales.member_id` -> apaga as vendas desse membro.
-- Cada venda apagada dispara o trigger `sales_after_change` (AFTER DELETE),
-- que chama `recalc_member_cycle(old.member_id, ...)` -- essa função faz um
-- `insert into cycles (member_id, ...) on conflict do update`. Nesse ponto
-- da mesma transação, a linha de `members` já foi removida, então o insert
-- em `cycles` viola `cycles_member_id_fkey` (member_id não existe mais em
-- members) -- a transação inteira falha, e o membro NÃO é apagado.
--
-- Correção: `recalc_member_cycle` primeiro confere se o membro ainda existe.
-- Se não existir (é exatamente o caso de estar sendo apagado em cascata),
-- não há por que recalcular ciclo nenhum -- a própria linha de `cycles`
-- também está sendo apagada em cascata (cycles.member_id também tem
-- `on delete cascade`), então só falta a função sair sem fazer nada.
-- ----------------------------------------------------------------------------
create or replace function recalc_member_cycle(p_member_id uuid, p_cycle_month date)
returns void
language plpgsql
as $$
declare
  v_count integer;
  v_gross numeric;
  v_net numeric;
  v_rewards record;
begin
  if not exists (select 1 from members where id = p_member_id) then
    return;
  end if;

  select count(*), coalesce(sum(gross_amount), 0), coalesce(sum(net_amount), 0)
    into v_count, v_gross, v_net
    from sales
    where member_id = p_member_id
      and date_trunc('month', sale_date)::date = p_cycle_month;

  select * into v_rewards from calculate_cycle_rewards(v_count, v_gross, v_net);

  insert into cycles (member_id, cycle_month, sales_count, gross_total, net_total, gift_card_value, commission_amount, updated_at)
  values (p_member_id, p_cycle_month, v_count, v_gross, v_net, v_rewards.gift_card_value, v_rewards.commission_amount, now())
  on conflict (member_id, cycle_month)
  do update set
    sales_count = excluded.sales_count,
    gross_total = excluded.gross_total,
    net_total = excluded.net_total,
    gift_card_value = excluded.gift_card_value,
    commission_amount = excluded.commission_amount,
    updated_at = now();
end;
$$;
