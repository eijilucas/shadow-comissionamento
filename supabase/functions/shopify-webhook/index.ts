// ============================================================================
// Edge Function: shopify-webhook
// Recebe eventos da Shopify, todos na mesma URL (diferenciados pelo header
// x-shopify-topic):
//   - orders/paid          -> insere a venda em `sales` (+ `sale_items`)
//   - orders/cancelled     -> apaga a venda (pedido cancelado)
//   - refunds/create       -> apaga a venda (pedido estornado, total ou parcial)
//   - discounts/create     -> cadastra o membro automaticamente (cupom novo)
//   - discount_codes/create -> idem, formato legado da API de price rules
//   - collections/create   -> adiciona a coleção nova em TODO cupom de
//     afiliado já sincronizado (write real na Shopify, usa
//     supabase/functions/_shared/shopify.ts com client credentials grant)
//   - discounts/delete     -> apaga o membro (login + histórico de vendas/
//     comissão) quando o cupom correspondente é apagado direto na Shopify --
//     mesmo comportamento (irreversível) do botão "Excluir" manual, só que
//     sem confirmação (evento automático não tem como pedir pra digitar o
//     cupom). Payload só traz o ID do desconto apagado, casado contra
//     members.shopify_discount_id.
// O trigger do banco recalcula o ciclo do mês automaticamente em qualquer
// insert/delete de `sales`.
//
// Loja única — assinatura HMAC verificada contra SHOPIFY_CLIENT_SECRET (o
// mesmo secret do app custom da Shopify, não um signing secret separado por
// webhook).
//
//   1. Defina os secrets da function:
//        npx supabase secrets set SHOPIFY_CLIENT_SECRET=<secret do app> --project-ref <ref>
//        (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem por padrão em
//        toda Edge Function, não precisa configurar.)
//   2. Deploy: npx supabase functions deploy shopify-webhook --project-ref <ref>
//   3. No admin da loja Shopify: Settings -> Notifications -> Webhooks ->
//      Create webhook, uma vez pra cada evento (mesma URL em todos):
//        -> Event: "Order payment" (orders/paid)
//        -> Event: "Order cancellation" (orders/cancelled)
//        -> Event: "Refund create" (refunds/create)
//        -> Event: "Discount creation" (discounts/create) — se não aparecer
//           essa opção na sua loja, procure "Discount code creation"
//           (discount_codes/create), que a function também entende.
//        -> Event: "Collection creation" (collections/create)
//        -> Event: "Discount deletion" (discounts/delete)
//        -> Format: JSON
//        -> URL: https://<seu-ref>.supabase.co/functions/v1/shopify-webhook
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  addCollectionsToDiscount,
  findDiscountIdByCode,
  getDiscountCollectionIds,
  getStoreConfig,
  ShopifyGraphQLError,
} from "../_shared/shopify.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SHOPIFY_CLIENT_SECRET = Deno.env.get("SHOPIFY_CLIENT_SECRET") ?? "";

// Precisa ficar igual a SYNTHETIC_LOGIN_DOMAIN em src/lib/auth.ts — é o
// domínio fake usado pra logar sem precisar de e-mail de verdade.
const SYNTHETIC_LOGIN_DOMAIN = "shadow.com";

// service role: esta função precisa escrever em `sales`/`members` e criar
// login no Auth, nada disso tem policy de escrita para usuários comuns (por
// design — só o backend pode gravar isso).
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

interface ShopifyDiscountCode {
  code: string;
}

interface ShopifyLineItem {
  title: string;
  quantity: number;
}

interface ShopifyOrderPayload {
  id: number | string;
  // subtotal_price = preço já com o desconto do cupom aplicado, mas ANTES
  // de frete e imposto — é exatamente a base que a comissão usa. total_price
  // (que inclui frete+imposto) não é usado pra isso, só fica disponível caso
  // precise no futuro.
  subtotal_price: string;
  total_price: string;
  created_at: string;
  discount_codes?: ShopifyDiscountCode[];
  // fallback: algumas lojas registram o cupom em discount_applications em vez de discount_codes
  discount_applications?: { code?: string; title?: string }[];
  line_items?: ShopifyLineItem[];
  // Gateways usados no pagamento -- inclui "gift_card" (total ou parcial)
  // quando o cliente pagou com crédito da loja.
  payment_gateway_names?: string[];
}

// Payload de refunds/create não é o pedido, é o reembolso — o id do pedido
// vem em order_id, não em id (id ali é o id do reembolso).
interface ShopifyRefundPayload {
  order_id: number | string;
}

// Mesma senha temporária padrão usada em scripts/create-member-logins.mjs e
// no create-member-login -- todo membro novo entra com essa senha (é
// forçado a trocar no primeiro login).
const DEFAULT_TEMP_PASSWORD = "shadowfallen2026";

// A Shopify manda formatos diferentes dependendo de qual API cria o
// desconto — tenta os caminhos mais comuns, do mais novo pro mais legado.
function extractDiscountCode(payload: Record<string, unknown>): string | null {
  const discount = payload.discount as Record<string, unknown> | undefined;
  const fromUnifiedCode = discount?.code as string | undefined;
  if (fromUnifiedCode) return fromUnifiedCode;

  // API unificada de desconto: pra desconto de código, o "title" É o código.
  const fromUnifiedTitle = discount?.title as string | undefined;
  if (fromUnifiedTitle) return fromUnifiedTitle;

  // discount_codes/create (legado, via price rule): { discount_code: { code } }
  const discountCode = payload.discount_code as Record<string, unknown> | undefined;
  const fromLegacy = discountCode?.code as string | undefined;
  if (fromLegacy) return fromLegacy;

  // fallback: campo direto no topo do payload
  const fromTopLevel = (payload.code as string | undefined) ?? (payload.title as string | undefined);
  if (fromTopLevel) return fromTopLevel;

  return null;
}

async function computeHmac(secret: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function verifyShopifyHmac(rawBody: string, hmacHeader: string | null): Promise<boolean> {
  if (!SHOPIFY_CLIENT_SECRET) {
    // Sem secret configurado ainda (ambiente de desenvolvimento): não bloqueia,
    // mas deixa claro nos logs que a verificação está desativada.
    console.warn("SHOPIFY_CLIENT_SECRET não configurado — pulando verificação HMAC (modo dev).");
    return true;
  }
  if (!hmacHeader) return false;

  const computedHmac = await computeHmac(SHOPIFY_CLIENT_SECRET, rawBody);
  return computedHmac === hmacHeader;
}

function extractCouponCode(order: ShopifyOrderPayload): string | null {
  const fromDiscountCodes = order.discount_codes?.[0]?.code;
  if (fromDiscountCodes) return fromDiscountCodes;

  const fromApplications = order.discount_applications?.find((d) => d.code)?.code;
  if (fromApplications) return fromApplications;

  return null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Pedido pago (total ou parcialmente) com gift card = crédito da loja, não
// venda "de verdade" -- não conta pro cupom do afiliado (ele podia usar o
// próprio gift card ou o de um terceiro só pra inflar as métricas).
function paidWithGiftCard(order: ShopifyOrderPayload): boolean {
  return (order.payment_gateway_names ?? []).some((g) => /gift.?card/i.test(g));
}

async function handleOrderPaid(order: ShopifyOrderPayload): Promise<Response> {
  const couponCode = extractCouponCode(order);
  if (!couponCode) {
    // Pedido pago sem cupom de afiliado: não é erro, só não gera comissão.
    return jsonResponse({ skipped: true, reason: "Pedido sem cupom de afiliado" });
  }

  if (paidWithGiftCard(order)) {
    return jsonResponse({ skipped: true, reason: "Pedido pago com gift card (crédito da loja) — não conta como venda" });
  }

  const { data: member, error: memberError } = await supabase
    .from("members")
    .select("id")
    .ilike("coupon_code", couponCode)
    .eq("active", true)
    .maybeSingle();

  if (memberError) {
    console.error("Erro ao buscar membro:", memberError);
    return jsonResponse({ error: "Erro interno ao buscar membro" }, 500);
  }

  if (!member) {
    // Cupom usado não pertence a nenhum membro cadastrado (cupom "normal" da loja).
    return jsonResponse({ skipped: true, reason: `Cupom '${couponCode}' não é de um membro` });
  }

  const { data: sale, error: insertError } = await supabase
    .from("sales")
    .insert({
      member_id: member.id,
      shopify_order_id: String(order.id),
      coupon_code: couponCode,
      gross_amount: Number(order.subtotal_price),
      sale_date: order.created_at ?? new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertError) {
    // Conflito de shopify_order_id (unique) = webhook duplicado da Shopify, ignora.
    if (insertError.code === "23505") {
      return jsonResponse({ skipped: true, reason: "Pedido já registrado" });
    }
    console.error("Erro ao inserir venda:", insertError);
    return jsonResponse({ error: "Erro interno ao inserir venda" }, 500);
  }

  const lineItems = order.line_items ?? [];
  if (lineItems.length > 0) {
    const { error: itemsError } = await supabase.from("sale_items").insert(
      lineItems.map((item) => ({
        sale_id: sale.id,
        product_name: item.title,
        quantity: item.quantity ?? 1,
      })),
    );
    // Não falha a request por causa disso — a venda já foi contabilizada,
    // os produtos são só para exibição.
    if (itemsError) console.error("Erro ao inserir itens da venda:", itemsError);
  }

  return jsonResponse({ ok: true, member_id: member.id, coupon_code: couponCode });
}

// Cancelamento ou reembolso (parcial ou total) reverte a venda inteira —
// simplificação de MVP: não tenta rastrear reembolso parcial item a item, só
// remove a venda pra não deixar peça/comissão presa em pedido que não vale
// mais. `sale_items` cai junto via `on delete cascade` (ver migration).
async function handleOrderReversal(orderId: string | number): Promise<Response> {
  const { error, count } = await supabase
    .from("sales")
    .delete({ count: "exact" })
    .eq("shopify_order_id", String(orderId));

  if (error) {
    console.error("Erro ao reverter venda:", error);
    return jsonResponse({ error: "Erro interno ao reverter venda" }, 500);
  }

  if (!count) {
    // Pedido cancelado/estornado nunca tinha gerado venda aqui (sem cupom de
    // afiliado, por exemplo) — nada a fazer.
    return jsonResponse({ skipped: true, reason: "Nenhuma venda registrada pra esse pedido" });
  }

  return jsonResponse({ ok: true, reverted_order_id: String(orderId) });
}

// Acha o discount_id do cupom recém-criado (ou já existente) e salva em
// members.shopify_discount_id -- sem isso o cupom fica invisível pra
// automação de "coleção nova" (aquele webhook só olha membros com essa
// coluna preenchida). Também sincroniza de cara com as coleções que um
// cupom nosso já rastreado tiver, já que um cupom criado direto na Shopify
// só vem com o que a pessoa selecionou na hora (normalmente incompleto em
// relação aos drops mais antigos). Best-effort: falha aqui não impede o
// resto do fluxo, só deixa sem auto-sync até um backfill manual.
async function linkAndSyncDiscount(memberId: string, couponCode: string): Promise<void> {
  const config = getStoreConfig();
  if (!config) return;

  // O índice de busca da Shopify (usado por findDiscountIdByCode) às vezes
  // ainda não indexou o desconto no exato momento em que o webhook
  // discounts/create chega -- sem retry, a busca vinha vazia e a gente
  // desistia calado.
  let discountId: string | null = null;
  for (const delayMs of [0, 1000, 2000, 4000]) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    discountId = await findDiscountIdByCode(config, couponCode);
    if (discountId) break;
  }
  if (!discountId) {
    console.error(`Não achou o discount_id do cupom ${couponCode} mesmo após retries -- índice da Shopify pode estar atrasado.`);
    return;
  }

  await supabase.from("members").update({ shopify_discount_id: discountId }).eq("id", memberId);

  // Tenta vários candidatos, não só "qualquer um" -- um molde cujo desconto
  // já foi apagado na Shopify (sobra de teste, por exemplo) devolve lista de
  // coleções vazia sem erro nenhum, e o cupom novo nascia sem coleção
  // nenhuma, calado. Prioriza os membros MAIS ANTIGOS (created_at asc) como
  // molde -- normalmente são afiliados de verdade, bem menos propensos a
  // serem apagados de repente do que um cupom de teste recém-criado. A
  // automação de coleção nova mantém todo mundo em dia de qualquer forma,
  // então não precisa ser o "mais novo" pra estar atualizado.
  const { data: referenceCandidates } = await supabase
    .from("members")
    .select("shopify_discount_id")
    .not("shopify_discount_id", "is", null)
    .neq("id", memberId)
    .order("created_at", { ascending: true })
    .limit(5);

  let collectionIds: string[] = [];
  for (const candidate of (referenceCandidates ?? []) as Record<string, unknown>[]) {
    const candidateId = candidate.shopify_discount_id as string;
    collectionIds = await getDiscountCollectionIds(config, candidateId);
    if (collectionIds.length > 0) break;
  }

  if (collectionIds.length > 0) {
    await addCollectionsToDiscount(config, discountId, collectionIds);
  } else {
    console.error(`Não achou nenhum molde de coleções válido pra sincronizar o cupom ${couponCode} -- todos os candidatos testados estavam vazios/apagados.`);
  }
}

// Cupom novo criado na Shopify -> cadastra o membro automaticamente. O nome
// sai igual ao código do cupom (a Shopify não sabe o nome de verdade do
// afiliado) — o admin corrige depois pelo ícone de lápis na tabela. Já cria
// o login junto (senha temporária): o admin pega uma senha nova a qualquer
// momento clicando em "Resetar senha" na tabela, não precisa guardar a
// gerada aqui.
async function handleDiscountCreated(payload: Record<string, unknown>): Promise<Response> {
  const rawCode = extractDiscountCode(payload);
  if (!rawCode) {
    return jsonResponse({ skipped: true, reason: "Payload sem código de cupom identificável" });
  }

  const couponCode = rawCode.trim().toUpperCase();
  if (!couponCode) {
    return jsonResponse({ skipped: true, reason: "Código de cupom vazio" });
  }

  const { data: existing, error: existingError } = await supabase
    .from("members")
    .select("id, shopify_discount_id")
    .ilike("coupon_code", couponCode)
    .maybeSingle();

  if (existingError) {
    console.error("Erro ao checar membro existente:", existingError);
    return jsonResponse({ error: "Erro interno ao checar membro existente" }, 500);
  }

  if (existing) {
    // Cupom já tem membro cadastrado, mas ainda não tem o discount_id salvo
    // -- vincula e sincroniza agora. Sem isso, um cupom recriado com o
    // mesmo código ficava pra sempre invisível pra automação.
    if (!existing.shopify_discount_id) {
      try {
        await linkAndSyncDiscount(existing.id, couponCode);
      } catch (err) {
        console.error(`Não achou/sincronizou o discount_id do cupom ${couponCode}:`, err);
      }
      return jsonResponse({ ok: true, member_id: existing.id, coupon_code: couponCode, linked: true });
    }

    return jsonResponse({ skipped: true, reason: `Já existe membro pro cupom '${couponCode}'` });
  }

  const email = `${couponCode.toLowerCase()}@${SYNTHETIC_LOGIN_DOMAIN}`;

  const { data: member, error: insertError } = await supabase
    .from("members")
    .insert({ name: couponCode, coupon_code: couponCode, email })
    .select("id")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      return jsonResponse({ skipped: true, reason: "Cupom já registrado (conflito de corrida)" });
    }
    console.error("Erro ao criar membro:", insertError);
    return jsonResponse({ error: "Erro interno ao criar membro" }, 500);
  }

  const tempPassword = DEFAULT_TEMP_PASSWORD;
  const { data: created, error: createAuthError } = await supabase.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { must_change_password: true },
  });

  if (createAuthError || !created.user) {
    // Membro já existe na tabela, só o login que falhou — o admin resolve
    // isso clicando em "Criar login" na tabela (mesmo caminho manual).
    console.error("Membro criado, mas falhou ao criar login:", createAuthError);
    return jsonResponse({ ok: true, member_id: member.id, coupon_code: couponCode, login_created: false });
  }

  const { error: linkError } = await supabase.from("members").update({ auth_user_id: created.user.id }).eq("id", member.id);
  if (linkError) {
    console.error("Login criado, mas falhou ao vincular ao membro:", linkError);
  }

  try {
    await linkAndSyncDiscount(member.id, couponCode);
  } catch (err) {
    console.error(`Não achou/sincronizou o discount_id do cupom ${couponCode}:`, err);
  }

  return jsonResponse({ ok: true, member_id: member.id, coupon_code: couponCode, login_created: !linkError });
}

interface ShopifyCollectionPayload {
  id: number | string;
  admin_graphql_api_id?: string;
}

function collectionGid(payload: ShopifyCollectionPayload): string {
  return payload.admin_graphql_api_id || `gid://shopify/Collection/${payload.id}`;
}

// Coleção nova criada na Shopify -> adiciona ela na lista de coleções
// elegíveis de TODO cupom de afiliado já sincronizado (mesma automação que o
// admin faria na mão, uma por uma, hoje). Operação aditiva e idempotente
// (ver addCollectionsToDiscount) -- seguro se a Shopify reenviar o mesmo
// webhook mais de uma vez.
async function handleCollectionCreated(payload: ShopifyCollectionPayload): Promise<Response> {
  const config = getStoreConfig();
  if (!config) {
    console.error("Credenciais da Shopify não configuradas");
    return jsonResponse({ error: "Credenciais da Shopify não configuradas" }, 500);
  }

  const { data: members, error } = await supabase.from("members").select("id, coupon_code, shopify_discount_id").not("shopify_discount_id", "is", null);

  if (error) {
    console.error("Erro ao buscar membros com cupom sincronizado:", error);
    return jsonResponse({ error: "Erro interno ao buscar membros" }, 500);
  }

  const collectionId = collectionGid(payload);
  const results: { coupon_code: string; ok: boolean; reason?: string }[] = [];

  for (const m of members ?? []) {
    const discountId = m.shopify_discount_id as string;
    try {
      await addCollectionsToDiscount(config, discountId, [collectionId]);
      results.push({ coupon_code: m.coupon_code, ok: true });
    } catch (err) {
      console.error(`Erro ao adicionar coleção no cupom ${m.coupon_code}:`, err);
      results.push({
        coupon_code: m.coupon_code,
        ok: false,
        reason: err instanceof ShopifyGraphQLError ? err.message : "Erro na Shopify",
      });
    }
  }

  const failed = results.filter((r) => !r.ok);
  return jsonResponse({ ok: true, collection_id: collectionId, updated: results.length - failed.length, failed });
}

interface ShopifyDiscountDeletedPayload {
  admin_graphql_api_id?: string;
  id?: number | string;
}

// Desconto apagado direto na Shopify -> apaga o membro correspondente por
// completo (login + histórico de vendas/comissão), igual o botão "Excluir"
// manual do painel -- irreversível, sem confirmação (evento automático não
// tem como pedir pra digitar o cupom). Casa o discount_id do payload contra
// members.shopify_discount_id.
async function handleDiscountDeleted(payload: ShopifyDiscountDeletedPayload): Promise<Response> {
  const discountId = payload.admin_graphql_api_id || (payload.id ? `gid://shopify/DiscountCodeNode/${payload.id}` : null);
  if (!discountId) {
    return jsonResponse({ skipped: true, reason: "Payload sem ID do desconto apagado" });
  }

  const { data: member, error } = await supabase
    .from("members")
    .select("id, coupon_code, name, auth_user_id, is_admin")
    .eq("shopify_discount_id", discountId)
    .maybeSingle();

  if (error) {
    console.error("Erro ao buscar membro pelo discount_id apagado:", error);
    return jsonResponse({ error: "Erro interno ao buscar membro" }, 500);
  }
  if (!member) {
    return jsonResponse({ skipped: true, reason: "Nenhum membro rastreado com esse discount_id" });
  }
  if (member.is_admin) {
    return jsonResponse({ skipped: true, reason: "Não apaga conta de admin automaticamente" });
  }

  if (member.auth_user_id) {
    const { error: deleteAuthError } = await supabase.auth.admin.deleteUser(member.auth_user_id);
    if (deleteAuthError && deleteAuthError.status !== 404) {
      console.error("Erro ao apagar login do membro:", deleteAuthError);
    }
  }

  const { error: deleteMemberError } = await supabase.from("members").delete().eq("id", member.id);
  if (deleteMemberError) {
    console.error("Login apagado, mas falhou ao apagar o membro:", deleteMemberError);
    return jsonResponse({ error: "Erro interno ao apagar o membro" }, 500);
  }

  return jsonResponse({ ok: true, deleted_coupon: member.coupon_code });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await req.text();
  const hmacHeader = req.headers.get("x-shopify-hmac-sha256");
  const rawTopic = req.headers.get("x-shopify-topic");
  const topic = rawTopic ?? "orders/paid";

  // Log incondicional de todo webhook recebido -- sem isso, um evento que
  // cai no caminho "skipped" (sem log próprio) fica indistinguível de um
  // evento que nunca chegou, na hora de debugar.
  console.log(`Webhook recebido: topic="${rawTopic}" hasHmac=${Boolean(hmacHeader)}`);

  const validHmac = await verifyShopifyHmac(rawBody, hmacHeader);
  if (!validHmac) {
    return jsonResponse({ error: "Assinatura HMAC inválida" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "JSON inválido" }, 400);
  }

  if (topic === "orders/cancelled") {
    const order = payload as unknown as ShopifyOrderPayload;
    return await handleOrderReversal(order.id);
  }

  if (topic === "refunds/create") {
    const refund = payload as unknown as ShopifyRefundPayload;
    return await handleOrderReversal(refund.order_id);
  }

  if (topic === "discounts/create" || topic === "discount_codes/create") {
    return await handleDiscountCreated(payload);
  }

  if (topic === "collections/create") {
    return await handleCollectionCreated(payload as unknown as ShopifyCollectionPayload);
  }

  if (topic === "discounts/delete") {
    return await handleDiscountDeleted(payload as unknown as ShopifyDiscountDeletedPayload);
  }

  return await handleOrderPaid(payload as unknown as ShopifyOrderPayload);
});
