// ============================================================================
// Edge Function: add-manual-sale
// Chamada pelo painel admin ("Adicionar Venda Manual") pra registrar um
// pedido fechado fora da Shopify (WhatsApp, por exemplo). Só service role
// pode inserir em `sales` (não existe policy de insert pra admin na tabela,
// só o webhook usa a service role), por isso precisa passar por function.
// O trigger de recálculo do ciclo dispara normalmente, igual uma venda vinda
// do webhook.
//
// Deploy:
//   npx supabase functions deploy add-manual-sale --project-ref <seu-ref>
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
    return jsonResponse({ error: "Só admin pode lançar venda manual" }, 403);
  }

  let body: { member_id?: string; gross_amount?: number; sale_date?: string; product_name?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "JSON inválido" }, 400);
  }

  const { member_id, gross_amount, sale_date, product_name } = body;

  if (!member_id) {
    return jsonResponse({ error: "member_id é obrigatório" }, 400);
  }
  if (typeof gross_amount !== "number" || !Number.isFinite(gross_amount) || gross_amount <= 0) {
    return jsonResponse({ error: "gross_amount precisa ser um número maior que zero" }, 400);
  }

  const { data: targetMember, error: targetError } = await adminClient
    .from("members")
    .select("id, coupon_code, active")
    .eq("id", member_id)
    .maybeSingle();

  if (targetError || !targetMember) {
    return jsonResponse({ error: "Membro não encontrado" }, 404);
  }
  if (!targetMember.active) {
    return jsonResponse({ error: "Membro está inativo" }, 400);
  }

  const { data: sale, error: insertError } = await adminClient
    .from("sales")
    .insert({
      member_id: targetMember.id,
      coupon_code: targetMember.coupon_code,
      gross_amount,
      sale_date: sale_date || new Date().toISOString(),
      source: "manual",
    })
    .select("id")
    .single();

  if (insertError || !sale) {
    console.error("Erro ao inserir venda manual:", insertError);
    return jsonResponse({ error: "Não deu pra registrar a venda" }, 500);
  }

  if (product_name && product_name.trim()) {
    const { error: itemError } = await adminClient
      .from("sale_items")
      .insert({ sale_id: sale.id, product_name: product_name.trim(), quantity: 1 });
    if (itemError) {
      console.error("Venda registrada, mas falhou ao registrar o item:", itemError);
    }
  }

  return jsonResponse({ ok: true, sale_id: sale.id });
});
