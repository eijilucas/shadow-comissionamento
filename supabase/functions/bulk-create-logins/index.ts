// ============================================================================
// Edge Function: bulk-create-logins
// Chamada pelo painel admin ("Criar login para pendentes") — cria a conta de
// login (Supabase Auth) de TODOS os membros ativos que ainda não têm uma,
// todos com a MESMA senha temporária informada. Mesmo efeito de rodar
// scripts/create-member-logins.mjs pelo terminal, mas direto do navegador,
// sem precisar da service role key na mão de ninguém (ela já está disponível
// pra function via env, só o admin logado consegue chamar).
//
// Deploy:
//   npx supabase functions deploy bulk-create-logins --project-ref <seu-ref>
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
    return jsonResponse({ error: "Só admin pode criar login em massa" }, 403);
  }

  let body: { temp_password?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "JSON inválido" }, 400);
  }

  const tempPassword = (body.temp_password ?? "").trim();
  if (tempPassword.length < 6) {
    return jsonResponse({ error: "Senha temporária precisa ter pelo menos 6 caracteres" }, 400);
  }

  const { data: pendingMembers, error: pendingError } = await adminClient
    .from("members")
    .select("id, name, coupon_code, email")
    .is("auth_user_id", null)
    .eq("active", true);

  if (pendingError) {
    console.error("Erro ao buscar membros pendentes:", pendingError);
    return jsonResponse({ error: "Erro interno ao buscar membros pendentes" }, 500);
  }

  const results: { coupon_code: string; name: string; ok: boolean; reason?: string }[] = [];

  for (const target of pendingMembers ?? []) {
    if (!target.email) {
      results.push({ coupon_code: target.coupon_code, name: target.name, ok: false, reason: "Sem e-mail cadastrado" });
      continue;
    }

    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email: target.email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { must_change_password: true },
    });

    if (createError || !created.user) {
      results.push({ coupon_code: target.coupon_code, name: target.name, ok: false, reason: createError?.message ?? "Erro ao criar login" });
      continue;
    }

    const { error: linkError } = await adminClient.from("members").update({ auth_user_id: created.user.id }).eq("id", target.id);

    if (linkError) {
      results.push({ coupon_code: target.coupon_code, name: target.name, ok: false, reason: "Login criado, mas não vinculou ao membro" });
      continue;
    }

    results.push({ coupon_code: target.coupon_code, name: target.name, ok: true });
  }

  return jsonResponse({ ok: true, results });
});
