-- ============================================================================
-- Shadow of the Fallen — Sistema de Comissionamento por Cupom
-- Schema completo, adaptado do projeto irmão Mental Madness (que tem duas
-- lojas Shopify) pra uma loja só. Migration única — sem replay de histórico
-- incremental, o schema já nasce no estado final.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- EXTENSÕES
-- ----------------------------------------------------------------------------
create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- TABELA: members
-- Um membro (afiliado) da marca. `auth_user_id` é ligado ao Supabase Auth
-- somente depois que o membro cria login — por isso é nullable, permitindo
-- cadastrar/seedar membros (e o cupom deles) antes de terem conta.
-- ----------------------------------------------------------------------------
create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  name text not null,
  email text unique,
  coupon_code text not null unique,
  is_admin boolean not null default false,
  active boolean not null default true,
  pix_key text, -- chave PIX pra pagamento de comissão (dia 5) — nullable, admin preenche
  -- tipo da chave (campo pixAddressKeyType da API do Asaas) — não dá pra
  -- inferir só pelo formato do texto (CPF e telefone com DDD têm os dois 11
  -- dígitos), por isso precisa ser explícito.
  pix_key_type text check (pix_key_type in ('CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP')),
  -- ID do desconto na Shopify (loja única) — usado pra sincronizar de volta
  -- (renomear/apagar) quando o membro é editado ou excluído no painel.
  -- Nullable: cupom pode ainda não estar sincronizado.
  shopify_discount_id text,
  -- e-mail real de contato (separado do e-mail sintético de login) -- pra
  -- onde manda o gift card de recompensa por peça, via Resend.
  contact_email text,
  created_at timestamptz not null default now()
);

create index if not exists idx_members_coupon_code on members (lower(coupon_code));
create index if not exists idx_members_auth_user_id on members (auth_user_id);

-- ----------------------------------------------------------------------------
-- TABELA: sales
-- Uma venda Shopify feita com o cupom de um membro. `shopify_order_id` é
-- único para tornar a inserção via webhook idempotente (Shopify pode
-- reenviar o mesmo webhook mais de uma vez).
-- ----------------------------------------------------------------------------
create table if not exists sales (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id) on delete cascade,
  shopify_order_id text unique,
  coupon_code text not null,
  gross_amount numeric(12,2) not null check (gross_amount >= 0),
  net_amount numeric(12,2), -- reservado para quando a comissão puder passar a ser sobre valor líquido
  sale_date timestamptz not null default now(),
  -- 'shopify' = veio do webhook, 'manual' = admin lançou (pedido fechado por
  -- WhatsApp, fora da Shopify).
  source text not null default 'shopify' check (source in ('shopify', 'manual')),
  created_at timestamptz not null default now()
);

create index if not exists idx_sales_member_id on sales (member_id);
create index if not exists idx_sales_sale_date on sales (sale_date);

-- ----------------------------------------------------------------------------
-- TABELA: sale_items
-- Os produtos de uma venda (um pedido Shopify pode ter mais de um item).
-- Só para exibição (quais peças o membro vendeu) — não entra em nenhum
-- cálculo de recompensa, que continua baseado em `sales`.
-- ----------------------------------------------------------------------------
create table if not exists sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales(id) on delete cascade,
  product_name text not null,
  quantity integer not null default 1 check (quantity > 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_sale_items_sale_id on sale_items (sale_id);

-- ----------------------------------------------------------------------------
-- TABELA: cycles
-- Um "ciclo" = a foto do mês (reseta todo dia 1) de um membro: quantas
-- vendas, valor bruto/líquido total, peças conquistadas e comissão
-- acumulada. É recalculada automaticamente pelo trigger em `sales`.
-- ----------------------------------------------------------------------------
create table if not exists cycles (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id) on delete cascade,
  cycle_month date not null, -- sempre o dia 1 do mês, ex: 2026-09-01
  sales_count integer not null default 0,
  gross_total numeric(12,2) not null default 0,
  net_total numeric(12,2) not null default 0,
  commission_amount numeric(12,2) not null default 0,
  -- Pagamento de comissão via PIX (dia 5) — o crédito fica na conta do
  -- Asaas, aqui só controla quem já foi pago.
  commission_paid boolean not null default false,
  commission_paid_at timestamptz,
  -- Recompensa por meta de venda no mês, ACUMULATIVA (calculada pelo
  -- trigger, ver calculate_cycle_rewards): 3 vendas -> R$100, 5 -> +R$150,
  -- 7 -> +R$150, 10 -> +R$250, 15 -> +R$400 (trava: 15+ = R$1.050). Um
  -- único gift card por membro no fechamento do mês. gift_card_sent / _at /
  -- _code = controle de envio, NÃO mexido pelo recálculo.
  gift_card_value numeric(12,2) not null default 0,
  gift_card_sent boolean not null default false,
  gift_card_sent_at timestamptz,
  gift_card_code text,
  updated_at timestamptz not null default now(),
  unique (member_id, cycle_month)
);

create index if not exists idx_cycles_member_id on cycles (member_id);
create index if not exists idx_cycles_cycle_month on cycles (cycle_month);

-- ----------------------------------------------------------------------------
-- TABELA: app_config
-- Configuração global de regras de negócio. Linha única (id = 1).
-- Existe para que a base de cálculo da comissão possa ser trocada sem
-- alterar código/deploy: basta um UPDATE nesta tabela.
-- ----------------------------------------------------------------------------
create table if not exists app_config (
  id smallint primary key default 1 check (id = 1),
  -- 'gross' = sobre o valor bruto vendido no mês
  -- 'net'   = sobre o valor líquido (requer preencher sales.net_amount)
  commission_base text not null default 'gross' check (commission_base in ('gross', 'net')),
  commission_rate numeric(5,4) not null default 0.05, -- 5% fixo, a partir de 6 vendas
  updated_at timestamptz not null default now()
);

insert into app_config (id) values (1) on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- FUNÇÃO: calculate_cycle_rewards
-- Núcleo da regra de negócio. Isolada nesta função para ser fácil de trocar
-- caso as regras mudem — nada mais no schema precisa ser alterado.
--
-- Regras (ponto de partida, vieram do projeto irmão Mental Madness — ajuste
-- livremente aqui e em src/lib/rewards.ts, os dois lugares precisam bater):
--   Gift card ACUMULATIVO por vendas no mês (soma ao longo do mês, um único
--   gift card no fechamento):
--     3 vendas  -> R$ 100
--     5 vendas  -> + R$ 150
--     7 vendas  -> + R$ 150
--     10 vendas -> + R$ 250
--     15 vendas -> + R$ 400   (trava aqui: 15+ = R$ 1.050 no total)
--   Comissão: `commission_rate` (5% fixo) a partir de 6 vendas, sobre o
--   valor vendido no mês inteiro (bruto ou líquido, conforme
--   app_config.commission_base).
-- ----------------------------------------------------------------------------
create or replace function calculate_cycle_rewards(
  p_sales_count integer,
  p_gross_total numeric,
  p_net_total numeric
)
returns table (gift_card_value numeric, commission_amount numeric)
language plpgsql
stable
as $$
declare
  v_base text;
  v_rate numeric;
  v_gift_card numeric := 0;
  v_commission numeric := 0;
  v_commission_base_amount numeric;
begin
  select commission_base, commission_rate
    into v_base, v_rate
    from app_config where id = 1;

  v_commission_base_amount := case when v_base = 'net' then coalesce(p_net_total, 0) else p_gross_total end;

  if p_sales_count >= 3 then v_gift_card := v_gift_card + 100; end if;
  if p_sales_count >= 5 then v_gift_card := v_gift_card + 150; end if;
  if p_sales_count >= 7 then v_gift_card := v_gift_card + 150; end if;
  if p_sales_count >= 10 then v_gift_card := v_gift_card + 250; end if;
  if p_sales_count >= 15 then v_gift_card := v_gift_card + 400; end if;

  v_commission := case when p_sales_count >= 6 then round(v_commission_base_amount * v_rate, 2) else 0 end;

  return query select v_gift_card, v_commission;
end;
$$;

-- ----------------------------------------------------------------------------
-- FUNÇÃO: recalc_member_cycle
-- Recalcula (upsert) a linha de `cycles` de um membro para um dado mês,
-- a partir do estado atual de `sales`.
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

-- ----------------------------------------------------------------------------
-- TRIGGER: recalcula o ciclo sempre que uma venda é inserida/alterada/apagada
-- ----------------------------------------------------------------------------
create or replace function trg_sales_recalc_cycle()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    perform recalc_member_cycle(old.member_id, date_trunc('month', old.sale_date)::date);
    return old;
  end if;

  perform recalc_member_cycle(new.member_id, date_trunc('month', new.sale_date)::date);

  if tg_op = 'UPDATE' and (old.member_id <> new.member_id or date_trunc('month', old.sale_date) <> date_trunc('month', new.sale_date)) then
    perform recalc_member_cycle(old.member_id, date_trunc('month', old.sale_date)::date);
  end if;

  return new;
end;
$$;

drop trigger if exists sales_after_change on sales;
create trigger sales_after_change
after insert or update or delete on sales
for each row execute function trg_sales_recalc_cycle();

-- ----------------------------------------------------------------------------
-- FUNÇÃO: recalc_all_cycles_for_month
-- Recalcula todos os ciclos de um mês de uma vez. Usada pelo painel admin
-- depois de editar app_config (comissão) — sem isso, a mudança só valeria
-- a partir da próxima venda de cada membro, o que ia confundir
-- (`security definer` porque precisa ler/escrever `cycles` de todo mundo,
-- mas só executa se quem chamou for admin).
-- ----------------------------------------------------------------------------
create or replace function recalc_all_cycles_for_month(p_cycle_month date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  if not is_admin_user() then
    raise exception 'Só admin pode recalcular ciclos em massa';
  end if;

  for r in select distinct member_id from cycles where cycle_month = p_cycle_month
  loop
    perform recalc_member_cycle(r.member_id, p_cycle_month);
  end loop;
end;
$$;

grant execute on function recalc_all_cycles_for_month(date) to authenticated;

-- ----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------
alter table members enable row level security;
alter table sales enable row level security;
alter table sale_items enable row level security;
alter table cycles enable row level security;
alter table app_config enable row level security;

-- helper: é o membro admin logado?
create or replace function is_admin_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from members where auth_user_id = auth.uid()), false);
$$;

-- members: cada membro vê a própria linha; admin vê todas
drop policy if exists members_select_own_or_admin on members;
create policy members_select_own_or_admin on members
  for select using (auth_user_id = auth.uid() or is_admin_user());

-- members: só admin cadastra membro novo
drop policy if exists members_insert_admin on members;
create policy members_insert_admin on members
  for insert with check (is_admin_user());

-- members: só admin edita membro existente (usado pelo lápis de editar na
-- tabela do painel admin — nome/cupom)
drop policy if exists members_update_admin on members;
create policy members_update_admin on members
  for update using (is_admin_user()) with check (is_admin_user());

-- members: só admin apaga membro de vez (botão "Excluir" no painel — apaga
-- em cascata sales/sale_items/cycles desse membro, é permanente). Bloqueia
-- apagar uma linha que é admin, mesmo por outro admin — reforço de RLS além
-- da checagem que já existe na Edge Function delete-member, pra fechar a
-- brecha de chamar a REST API direto sem passar pela function.
drop policy if exists members_delete_admin on members;
create policy members_delete_admin on members
  for delete using (is_admin_user() and not is_admin);

-- sales: cada membro vê só as próprias vendas; admin vê todas
drop policy if exists sales_select_own_or_admin on sales;
create policy sales_select_own_or_admin on sales
  for select using (
    member_id in (select id from members where auth_user_id = auth.uid())
    or is_admin_user()
  );

-- sale_items: mesmo critério de sales, via join
drop policy if exists sale_items_select_own_or_admin on sale_items;
create policy sale_items_select_own_or_admin on sale_items
  for select using (
    sale_id in (
      select id from sales where member_id in (select id from members where auth_user_id = auth.uid())
    )
    or is_admin_user()
  );

-- cycles: idem
drop policy if exists cycles_select_own_or_admin on cycles;
create policy cycles_select_own_or_admin on cycles
  for select using (
    member_id in (select id from members where auth_user_id = auth.uid())
    or is_admin_user()
  );

-- cycles: só admin pode atualizar. Hoje a marcação de gift_card_sent e
-- commission_paid vem por Edge Function (service role, que ignora RLS),
-- mas a policy fica pra qualquer ajuste manual futuro pelo painel.
drop policy if exists cycles_update_admin on cycles;
create policy cycles_update_admin on cycles
  for update using (is_admin_user()) with check (is_admin_user());

-- app_config: leitura liberada para qualquer usuário autenticado (só exibição)
drop policy if exists app_config_select_authenticated on app_config;
create policy app_config_select_authenticated on app_config
  for select using (auth.role() = 'authenticated');

-- app_config: só admin edita (usado pela seção "Configurações" no painel admin)
drop policy if exists app_config_update_admin on app_config;
create policy app_config_update_admin on app_config
  for update using (is_admin_user()) with check (is_admin_user());

-- Nenhuma outra policy de insert/update/delete é criada pros membros comuns:
-- toda escrita em sales/sale_items/cycles acontece via Service Role (Edge
-- Function do webhook Shopify, ou as edge functions administrativas), nunca
-- diretamente pelo cliente autenticado.

-- ----------------------------------------------------------------------------
-- REALTIME
-- Habilita os eventos em tempo real usados pelo painel (sales e cycles).
-- ----------------------------------------------------------------------------
alter publication supabase_realtime add table sales;
alter publication supabase_realtime add table cycles;
alter publication supabase_realtime add table sale_items;
alter publication supabase_realtime add table app_config;

-- ----------------------------------------------------------------------------
-- Depois de criar a conta de admin em Authentication → Users, rode:
--
-- insert into members (name, email, coupon_code, is_admin, auth_user_id)
-- values ('Nome do Admin', 'admin@exemplo.com', 'ADMIN', true, '<auth_user_id copiado do painel>');
-- ----------------------------------------------------------------------------
