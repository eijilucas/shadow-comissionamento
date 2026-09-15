# Shadow of the Fallen - Comissionamento

Adaptado do projeto irmão **Mental Madness — Comissionamento por Cupom**,
mesma arquitetura, uma loja Shopify só. Painel de comissionamento por cupom
de afiliado: cada afiliado tem um cupom de desconto na Shopify, e o painel
acompanha vendas, comissão e gift card de recompensa por meta, mês a mês.

Stack: Vite + React 19 + TypeScript + react-router-dom + @supabase/supabase-js.

## Estado atual

Este repositório é só o **código**, adaptado pra uma loja só (o Mental
Madness original tem duas: Basic e Exclusivos). Também não tem "Vendas
Externas" — outro sistema da Mental Madness (pedido fechado por
WhatsApp/Instagram/Discord fora do checkout, com idempotência própria) que
a Shadow of the Fallen não vai ter. Se um dia fizer falta aqui, o caminho é
olhar `sales.external_order_id` e a function `register-external-order-sale`
do projeto irmão.

O ecossistema da marca é Shopify + o app irmão **Mental Jackpot** (lucro
líquido, já clonado em `../jackpot`) + este comissionamento — não tem
mm-etiquetas nem Vendas Externas.

Passos de infra — estado em 15/09/2026:

- [x] ~~Criar o app customizado principal na loja Shopify~~ — feito.
      Loja `zu1bmt-6k.myshopify.com`, escopos `read_discounts`,
      `write_discounts`, `read_products`. Client ID/Secret já configurados
      como secrets da function (ver abaixo).
- [ ] Criar o SEGUNDO app, o de gift card, com escopo `write_gift_cards`
      (ver seção "Gift card" abaixo) — ainda não feito.
- [x] ~~Criar um projeto Supabase novo~~ — feito: `rveyiabuqhcfiezklhms`
      (`https://rveyiabuqhcfiezklhms.supabase.co`).
- [x] ~~Rodar a migration~~ — feito, `20260912000001_init.sql` aplicada via
      `npx supabase db push --db-url "postgresql://postgres.rveyiabuqhcfiezklhms:<senha>@aws-0-sa-east-1.pooler.supabase.com:6543/postgres"`.
      Usa o **pooler** (porta 6543, transação), não a conexão direta
      (`db.<ref>.supabase.co:5432`) — essa só resolve em IPv6, e falhou com
      `ECONNREFUSED` num ambiente sem rota IPv6.
- [x] ~~Configurar os secrets do app principal~~ — feito:
      `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`.
      Ainda faltam `RESEND_API_KEY`, `ASAAS_API_KEY` e os dois
      `SHOPIFY_GIFTCARD_CLIENT_*` (dependem do segundo app, acima).
- [x] ~~Deploy das Edge Functions~~ — feito, as 10 estão `ACTIVE`.
      `shopify-webhook` confirmado com `verify_jwt: false` (as outras 9 com
      `true`, correto). Testado com um POST sem HMAC: respondeu
      `401 Assinatura HMAC inválida` — confirma que a function está no ar
      *e* que `SHOPIFY_CLIENT_SECRET` está configurado (sem o secret, a
      function loga um warn e deixa passar, "modo dev").
- [ ] Registrar os webhooks na Shopify (ver lista de eventos abaixo) — a
      URL já está pronta: `https://rveyiabuqhcfiezklhms.supabase.co/functions/v1/shopify-webhook`.
- [x] ~~Deploy do frontend~~ — feito, no ar em
      `https://shadow-comissao.vercel.app` (projeto Vercel
      `eiji-mental/shadow-comissao`, ligado ao repo do GitHub — todo push em
      `master` faz redeploy automático). Env vars `VITE_SUPABASE_URL` /
      `VITE_SUPABASE_ANON_KEY` configuradas em Production, mesmos valores do
      `.env` local (não versionado).
- [ ] Subir os assets de e-mail (logo, banner, ícones) num bucket
      `email-assets` do Supabase Storage do projeto novo, e trocar as URLs
      placeholder em `supabase/functions/send-gift-card/index.ts`
      (`EMAIL_ASSETS_BASE`, `STORE_URL`, e os links de redes sociais no
      rodapé do e-mail).
- [x] ~~Trocar a logo~~ — feito. `public/logo-m.png` e `public/favicon.png`
      são o wordmark branco com fundo transparente (256×256),
      `public/favicon.svg` é o mesmo desenho trocando pra preto na aparência
      clara (`prefers-color-scheme`), e `public/logo-m-original-black-bg.png`
      é o card 1200×630 sobre preto. Origem: arte de 225×225, recortada por
      luminância → alpha. Se aparecer um vetor da marca, vale regerar: hoje
      o glifo ocupa só 144×207 px nativos, e por isso fica pequeno no card
      de compartilhamento.
- [x] ~~Trocar as URLs do `index.html`~~ — feito, apontam pra
      `shadow-comissao.vercel.app`.
- [x] ~~Inserir o e-mail de admin~~ — feito. `lucas@hinfros.com.br`,
      cupom `ADMIN`, `is_admin: true`, linkado ao usuário de Auth
      correspondente. Login funciona por e-mail (ver `resolveLoginEmail`
      em `src/lib/auth.ts` — login com `@` é tratado como e-mail real, não
      cupom).

> **Antes de rodar qualquer `supabase` aqui:** sempre passe
> `--project-ref <ref do projeto NOVO>` explícito em qualquer comando
> (`db push`, `functions deploy`, `secrets set`) — ou rode
> `npx supabase link` apontando pro projeto certo antes. Um deploy no ref
> errado sobrescreve o schema ou as functions de outro projeto (Mental
> Madness ou Mental Jackpot). Nunca comite a service role key em lugar
> nenhum — nem no `.env`, nem em migration, nem em log.

## Criar acesso pra alguém

Sem cadastro aberto na tela de login. Um membro é criado de dois jeitos:

1. **Automático**: a Shopify manda o webhook `discounts/create` (ou
   `discount_codes/create`) quando um cupom novo é criado no admin da loja
   — o `shopify-webhook` cadastra o membro e já cria o login com a senha
   temporária padrão.
2. **Manual**: inserir direto na tabela `members` (SQL Editor do Supabase)
   e depois usar o botão "Criar login" na tabela do painel admin, ou rodar
   `scripts/create-member-logins.mjs`.

Pra dar acesso de **admin**: crie a conta em Authentication → Users no
painel do Supabase, copie o `auth_user_id`, e rode o `insert` comentado no
final da migration `20260912000001_init.sql` (`is_admin = true`).

## Rodar localmente

```
npm install
npm run dev
```

Copiar `.env.example` pra `.env` e preencher com a URL e a anon key do
projeto Supabase novo.

## Uma loja Shopify

Diferente do Mental Madness original (duas lojas, Basic e Exclusivos),
aqui é uma loja só. Os secrets são sem sufixo:

```
npx supabase secrets set SHOPIFY_STORE_DOMAIN=sualoja.myshopify.com --project-ref <ref>
npx supabase secrets set SHOPIFY_CLIENT_ID=<Client ID do app> --project-ref <ref>
npx supabase secrets set SHOPIFY_CLIENT_SECRET=<Client Secret do app> --project-ref <ref>
npx supabase secrets set RESEND_API_KEY=<API key da conta Resend> --project-ref <ref>
npx supabase secrets set ASAAS_API_KEY=<API key da conta Asaas> --project-ref <ref>
```

Gift card usa um app Shopify **separado**, só com o escopo
`write_gift_cards` (edição de escopo de app já instalado é conhecida por
não pegar na Shopify, por isso é outro app, não o mesmo do sync de cupom):

```
npx supabase secrets set SHOPIFY_GIFTCARD_CLIENT_ID=<Client ID do app de gift card> --project-ref <ref>
npx supabase secrets set SHOPIFY_GIFTCARD_CLIENT_SECRET=<Client Secret do app de gift card> --project-ref <ref>
```

(`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já existem por padrão em toda
Edge Function, não precisa configurar.)

## Webhook da Shopify e o mecanismo de HMAC

Código em `supabase/functions/shopify-webhook/index.ts`. Atende UMA loja só,
numa única URL, diferenciando o evento pelo header `x-shopify-topic`:

- `orders/paid` — cria a venda (`sales` + `sale_items`), respeitando
  `payment_gateway_names` pra ignorar pedido pago com gift card (crédito da
  loja não conta como venda de afiliado).
- `orders/cancelled` / `refunds/create` — reverte a venda (apaga a linha,
  simplificação de MVP: não rastreia reembolso parcial item a item).
- `discounts/create` / `discount_codes/create` — cadastra o membro
  automaticamente quando um cupom novo é criado direto no admin da Shopify,
  já com login (senha temporária).
- `collections/create` — propaga a coleção nova pra todo cupom de afiliado
  já sincronizado (write real na Shopify).
- `discounts/delete` — apaga o membro (login + histórico) quando o cupom é
  apagado direto na Shopify, mesmo comportamento irreversível do botão
  "Excluir" manual do painel.

**Autenticação**: a assinatura HMAC do corpo é verificada contra
`SHOPIFY_CLIENT_SECRET` — o mesmo secret do app custom da Shopify, não um
signing secret separado por webhook (esse é o padrão simplificado de loja
única que o Mental Jackpot já usa; o Mental Madness original, com duas
lojas, usa dois secrets `SHOPIFY_WEBHOOK_SECRET_BASIC`/`_EXCLUSIVOS`
diferentes, um por loja).

Registrar os webhooks na Shopify (Settings → Notifications → Webhooks, ou
via Admin API), todos apontando pra
`https://<seu-ref>.supabase.co/functions/v1/shopify-webhook`, formato JSON:

- Order payment (`orders/paid`)
- Order cancellation (`orders/cancelled`)
- Refund create (`refunds/create`)
- Discount creation (`discounts/create`) — se não aparecer essa opção,
  procure "Discount code creation" (`discount_codes/create`)
- Collection creation (`collections/create`)
- Discount deletion (`discounts/delete`)

## Regras de negócio

Os valores de gift card e a comissão são o **ponto de partida**, herdados
da Mental Madness (decisão de manter os mesmos números por enquanto) — dá
pra ajustar livremente depois. Os dois lugares que precisam ficar
sincronizados se você mudar algum valor:

1. `calculate_cycle_rewards` (função SQL, em
   `supabase/migrations/20260912000001_init.sql`) — é quem calcula de
   verdade e grava em `cycles`.
2. `src/lib/rewards.ts` — só exibição (barra de progresso, textos), tem que
   bater com o SQL.

Regras atuais:

- **Gift card acumulativo** por vendas no mês (soma ao longo do mês, um
  único gift card no fechamento): 3 vendas → R$100, 5 → +R$150, 7 →
  +R$150, 10 → +R$250, 15 → +R$400 (trava aqui: 15+ = R$1.050 no total).
- **Comissão fixa de 5%** a partir de 6 vendas/mês, sobre o valor vendido
  no mês inteiro (`app_config.commission_base`: bruto por padrão).

## Deploy das functions

Sem argumento, `functions deploy` publica todas de uma vez só (lê
`verify_jwt` de cada uma em `supabase/config.toml`, não precisa listar):

```
npx supabase functions deploy --project-ref rveyiabuqhcfiezklhms
```

Precisa de `SUPABASE_ACCESS_TOKEN` no ambiente (Personal Access Token, gerado
em `supabase.com/dashboard/account/tokens`) — `--project-ref` sozinho não
autentica, e a senha do banco (usada no `db push`) não serve aqui, é uma API
diferente (Management API da conta, não o Postgres).

`shopify-webhook` precisa de `verify_jwt = false` — já está declarado em
`supabase/config.toml` (`[functions.shopify-webhook]`), porque a
autenticação dela é a assinatura HMAC do corpo, não um JWT do Supabase; sem
isso o gateway devolve 401 antes da function rodar. Confirmado com
`supabase functions list` (`"verify_jwt":false` só nela) e com um POST sem
assinatura, que devolveu `401 Assinatura HMAC inválida` — HTTP 401 na
resposta da própria function, e não um 401 genérico do gateway.

## Segurança

- **Nunca** comite a service role key em lugar nenhum — nem no `.env` (que
  já está no `.gitignore`), nem em migration, nem em log, nem no chat.
- **Sempre** use `--project-ref <ref>` explícito em qualquer comando
  `supabase` (`db push`, `functions deploy`, `secrets set`) — evita
  sobrescrever o schema ou as functions do projeto errado (Mental Madness
  ou Mental Jackpot).
- `member-credentials.csv` (gerado por `scripts/create-member-logins.mjs`)
  já está no `.gitignore` — nunca comite esse arquivo, tem senha temporária
  de membro de verdade.

## Scripts utilitários

`scripts/create-member-logins.mjs` e `scripts/reset-member-password.mjs`
são utilitários Node genéricos de criação/reset de login em massa — rodam
localmente, com a service role key na mão (nunca cole ela no chat). Veja o
comentário no topo de cada arquivo pra instruções de uso.
