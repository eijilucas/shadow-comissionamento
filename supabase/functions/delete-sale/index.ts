// ============================================================================
// Edge Function: delete-sale
// Chamada pelo painel admin (botão "Remover" na tabela "Vendas do Mês") pra
// apagar uma venda lançada errada (manual ou vinda do webhook). O trigger
// `sales_after_change` recalcula o ciclo do membro automaticamente depois do
// delete, então comissão/peças/vendas do mês já saem certos.
//
// Deploy:
//   npx supabase functions deploy delete-sale --project-ref <seu-ref>
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

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
    return jsonResponse({ error: "Só admin pode remover venda" }, 403);
  }

  let body: { sale_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "JSON inválido" }, 400);
  }

  if (!body.sale_id) {
    return jsonResponse({ error: "sale_id é obrigatório" }, 400);
  }

  const { data: sale, error: saleError } = await adminClient
    .from("sales")
    .select("id")
    .eq("id", body.sale_id)
    .maybeSingle();

  if (saleError || !sale) {
    return jsonResponse({ error: "Venda não encontrada" }, 404);
  }

  const { error: deleteError } = await adminClient.from("sales").delete().eq("id", sale.id);

  if (deleteError) {
    console.error("Erro ao apagar venda:", deleteError);
    return jsonResponse({ error: "Não deu pra remover a venda" }, 500);
  }

  return jsonResponse({ ok: true });
});
