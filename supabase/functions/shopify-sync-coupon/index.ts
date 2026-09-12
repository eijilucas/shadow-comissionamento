// ============================================================================
// Edge Function: shopify-sync-coupon
// Chamada pelo painel admin pra manter o cupom sincronizado com a Shopify
// (mão dupla -- diferente do webhook shopify-webhook, que só recebe eventos
// DE LÁ pra cá).
//
// action "create": membro novo -- cria o desconto na loja, clonando a lista
//   de coleções de outro membro JÁ RASTREADO por nós (todo cupom de
//   afiliado compartilha as mesmas coleções, mantidas em sincronia pela
//   automação de coleção nova). Nunca clona de "o desconto mais recente da
//   loja" -- um cupom criado manualmente na Shopify pode nunca ter sido
//   sincronizado. Salva o ID retornado em members.shopify_discount_id.
// action "rename": cupom do membro mudou -- renomeia (code E title juntos)
//   se ele já tiver um shopify_discount_id salvo.
//
// Exclusão fica dentro de delete-member (mais simples manter atômico com a
// própria exclusão do membro).
//
// Deploy:
//   npx supabase functions deploy shopify-sync-coupon --project-ref <seu-ref>
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import {
  createAffiliateDiscount,
  getDiscountCollectionIds,
  getStoreConfig,
  renameAffiliateDiscount,
  ShopifyGraphQLError,
} from "../_shared/shopify.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const callerToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!callerToken) return jsonResponse({ error: "Não autenticado" }, 401);

  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${callerToken}` } },
  });
  const { data: callerData, error: callerError } = await callerClient.auth.getUser();
  if (callerError || !callerData.user) return jsonResponse({ error: "Não autenticado" }, 401);

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: callerMember, error: callerMemberError } = await adminClient
    .from("members")
    .select("is_admin")
    .eq("auth_user_id", callerData.user.id)
    .maybeSingle();
  if (callerMemberError || !callerMember?.is_admin) {
    return jsonResponse({ error: "Só admin pode sincronizar cupom com a Shopify" }, 403);
  }

  let body: { member_id?: string; action?: "create" | "rename"; new_coupon_code?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "JSON inválido" }, 400);
  }

  if (!body.member_id || !body.action) {
    return jsonResponse({ error: "member_id e action são obrigatórios" }, 400);
  }

  const { data: member, error: memberError } = await adminClient
    .from("members")
    .select("id, coupon_code, shopify_discount_id")
    .eq("id", body.member_id)
    .maybeSingle();
  if (memberError || !member) return jsonResponse({ error: "Membro não encontrado" }, 404);

  if (body.action === "create") {
    const config = getStoreConfig();
    if (!config) {
      return jsonResponse({ error: "Credenciais da Shopify não configuradas" }, 500);
    }
    if (member.shopify_discount_id) {
      return jsonResponse({ ok: true, reason: "Já tinha cupom sincronizado, não mexeu" });
    }

    const { data: appConfig } = await adminClient.from("app_config").select("commission_rate").eq("id", 1).maybeSingle();
    const percentage = appConfig?.commission_rate ?? 0.05;

    try {
      // Molde vem de um membro NOSSO já rastreado (shopify_discount_id
      // salvo), nunca de "o desconto mais recente da loja" -- um cupom
      // criado manualmente na Shopify (fora do nosso sistema) pode nunca
      // ter sido sincronizado com as coleções novas, e usar ele como molde
      // propagaria essa lista incompleta pra todo cupom criado depois.
      // Tenta vários candidatos, priorizando os mais ANTIGOS (afiliados de
      // verdade, bem menos propensos a serem apagados de repente que um
      // cupom de teste recém-criado) -- um molde cujo desconto já foi
      // apagado devolve lista vazia sem erro nenhum.
      const { data: referenceCandidates } = await adminClient
        .from("members")
        .select("shopify_discount_id")
        .not("shopify_discount_id", "is", null)
        .order("created_at", { ascending: true })
        .limit(5);
      let collectionIds: string[] = [];
      for (const candidate of referenceCandidates ?? []) {
        const candidateId = candidate.shopify_discount_id as string;
        collectionIds = await getDiscountCollectionIds(config, candidateId);
        if (collectionIds.length > 0) break;
      }

      const discountId = await createAffiliateDiscount(config, { code: member.coupon_code, percentage, collectionIds });
      const { error: saveError } = await adminClient.from("members").update({ shopify_discount_id: discountId }).eq("id", member.id);
      if (saveError) {
        console.error("Cupom criado na Shopify, mas falhou ao salvar o ID no banco:", saveError);
        return jsonResponse({ error: "Criado na Shopify, mas não salvou o vínculo no banco -- avisa o suporte" }, 500);
      }
      return jsonResponse({ ok: true });
    } catch (err) {
      console.error("Erro ao criar cupom na Shopify:", err);
      return jsonResponse({ error: err instanceof ShopifyGraphQLError ? err.message : "Erro ao criar na Shopify" }, 500);
    }
  } else if (body.action === "rename") {
    const newCode = (body.new_coupon_code ?? member.coupon_code).trim().toUpperCase();
    if (!member.shopify_discount_id) {
      return jsonResponse({ ok: true, reason: "Cupom ainda não sincronizado com a Shopify, nada a renomear" });
    }
    const config = getStoreConfig();
    if (!config) {
      return jsonResponse({ error: "Credenciais da Shopify não configuradas" }, 500);
    }
    try {
      await renameAffiliateDiscount(config, member.shopify_discount_id, newCode);
      return jsonResponse({ ok: true });
    } catch (err) {
      console.error("Erro ao renomear cupom na Shopify:", err);
      return jsonResponse({ error: err instanceof ShopifyGraphQLError ? err.message : "Erro ao renomear na Shopify" }, 500);
    }
  }

  return jsonResponse({ error: "action inválida" }, 400);
});
