// ============================================================================
// Edge Function: create-member-login
// Chamada pelo painel admin logo depois de cadastrar um membro novo — cria a
// conta de login (Supabase Auth) na hora, sem precisar rodar
// scripts/create-member-logins.mjs pelo terminal. Mesmo padrão do
// reset-member-password: só admin pode chamar, gera senha temporária,
// marca user_metadata.must_change_password = true (força troca no primeiro
// login) e devolve a senha pro admin copiar.
//
// Deploy:
//   npx supabase functions deploy create-member-login --project-ref <seu-ref>
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

// Mesma senha temporária padrão usada em scripts/create-member-logins.mjs e
// no botão "Criar Login para Pendentes" do painel -- todo membro novo entra
// com essa senha (é forçado a trocar no primeiro login).
const DEFAULT_TEMP_PASSWORD = "shadowfallen2026";

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
    return jsonResponse({ error: "Só admin pode criar login de membro" }, 403);
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
    .select("id, coupon_code, name, email, auth_user_id")
    .eq("id", body.member_id)
    .maybeSingle();

  if (targetError || !targetMember) {
    return jsonResponse({ error: "Membro não encontrado" }, 404);
  }

  if (targetMember.auth_user_id) {
    return jsonResponse({ error: "Esse membro já tem login — use \"Resetar senha\" em vez disso" }, 400);
  }

  if (!targetMember.email) {
    return jsonResponse({ error: "Esse membro não tem e-mail cadastrado" }, 400);
  }

  const tempPassword = DEFAULT_TEMP_PASSWORD;

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email: targetMember.email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { must_change_password: true },
  });

  if (createError || !created.user) {
    console.error("Erro ao criar login:", createError);
    return jsonResponse({ error: createError?.message ?? "Erro interno ao criar login" }, 500);
  }

  const { error: linkError } = await adminClient
    .from("members")
    .update({ auth_user_id: created.user.id })
    .eq("id", targetMember.id);

  if (linkError) {
    console.error("Criou o login mas falhou ao vincular:", linkError);
    return jsonResponse({ error: "Login criado, mas não deu pra vincular ao membro. Chama o suporte." }, 500);
  }

  return jsonResponse({ ok: true, coupon_code: targetMember.coupon_code, name: targetMember.name, temp_password: tempPassword });
});
