// ============================================================================
// Edge Function: delete-member
// Chamada pelo painel admin (botão "Excluir" na tabela de membros). Apaga o
// cupom na Shopify (se o membro tiver um, mão dupla), a conta de Auth do
// membro (se existir) e depois a linha em `members` — nessa ordem, porque só
// o backend (service role) pode apagar conta de Auth. Antes disso o
// "Excluir" só apagava `members` direto do client, deixando a conta de Auth
// órfã: se alguém recriasse o membro com o mesmo cupom/e-mail depois, a Auth
// recusava por "already registered".
//
// A falha ao apagar da Shopify NÃO trava a exclusão (o admin já confirmou
// digitando o cupom, não faz sentido travar por causa de uma API externa) —
// só reporta de volta pra o admin poder apagar manualmente se precisar.
//
// Deploy:
//   npx supabase functions deploy delete-member --project-ref <seu-ref>
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { deleteAffiliateDiscount, getStoreConfig, ShopifyGraphQLError } from "../_shared/shopify.ts";

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
  if (!callerToken) {
    return jsonResponse({ error: "Não autenticado" }, 401);
  }

  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${callerToken}` } },
  });

  const { data: callerData, error: callerError } = await callerClient.auth.getUser();
  if (callerError || !callerData.user) {
    return jsonResponse({ error: "Não autenticado" }, 401);
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: callerMember, error: callerMemberError } = await adminClient
    .from("members")
    .select("is_admin")
    .eq("auth_user_id", callerData.user.id)
    .maybeSingle();

  if (callerMemberError || !callerMember?.is_admin) {
    return jsonResponse({ error: "Só admin pode excluir membro" }, 403);
  }

  let body: { member_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "JSON inválido" }, 400);
  }

  if (!body.member_id) {
    return jsonResponse({ error: "member_id é obrigatório" }, 400);
  }

  const { data: targetMember, error: targetError } = await adminClient
    .from("members")
    .select("id, coupon_code, name, auth_user_id, is_admin, shopify_discount_id")
    .eq("id", body.member_id)
    .maybeSingle();

  if (targetError || !targetMember) {
    return jsonResponse({ error: "Membro não encontrado" }, 404);
  }

  if (targetMember.is_admin) {
    return jsonResponse({ error: "Não dá pra excluir uma conta de admin por aqui" }, 400);
  }

  let shopifyDeleteFailure: string | undefined;
  if (targetMember.shopify_discount_id) {
    const config = getStoreConfig();
    if (config) {
      try {
        await deleteAffiliateDiscount(config, targetMember.shopify_discount_id);
      } catch (err) {
        console.error("Erro ao apagar cupom na Shopify:", err);
        shopifyDeleteFailure = err instanceof ShopifyGraphQLError ? err.message : "Erro ao apagar na Shopify";
      }
    }
  }

  if (targetMember.auth_user_id) {
    const { error: deleteAuthError } = await adminClient.auth.admin.deleteUser(targetMember.auth_user_id);
    // Se a conta de Auth já não existir mais por algum motivo, ignora e segue
    // pra apagar o membro mesmo assim — não é motivo pra travar a exclusão.
    if (deleteAuthError && deleteAuthError.status !== 404) {
      console.error("Erro ao apagar login do membro:", deleteAuthError);
      return jsonResponse({ error: deleteAuthError.message ?? "Erro interno ao apagar o login do membro" }, 500);
    }
  }

  const { error: deleteMemberError } = await adminClient.from("members").delete().eq("id", targetMember.id);

  if (deleteMemberError) {
    console.error("Login apagado, mas falhou ao apagar o membro:", deleteMemberError);
    return jsonResponse({ error: "Login apagado, mas não deu pra apagar o membro. Chama o suporte." }, 500);
  }

  return jsonResponse({
    ok: true,
    coupon_code: targetMember.coupon_code,
    name: targetMember.name,
    shopify_delete_warning: shopifyDeleteFailure
      ? `Membro apagado, mas não deu pra apagar o cupom na Shopify (${shopifyDeleteFailure}) — apaga manualmente lá.`
      : undefined,
  });
});
