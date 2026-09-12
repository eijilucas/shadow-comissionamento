// ============================================================================
// Edge Function: reset-member-password
// Chamada pelo painel admin (botão "Resetar senha" na tabela de membros).
// Só quem é admin (is_admin = true na tabela `members`) pode resetar a senha
// de outro membro. Gera uma senha temporária nova, marca
// user_metadata.must_change_password = true (o painel força a troca no
// próximo login — ver src/pages/ForceChangePassword.tsx) e devolve a senha
// pro admin copiar e passar pro membro.
//
// Deploy:
//   npx supabase functions deploy reset-member-password --project-ref <seu-ref>
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

function randomTempPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return "sf-" + btoa(String.fromCharCode(...bytes)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
}

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

  // client "como o chamador" — só pra descobrir quem é a pessoa logada
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${callerToken}` } },
  });

  const { data: callerData, error: callerError } = await callerClient.auth.getUser();
  if (callerError || !callerData.user) {
    return jsonResponse({ error: "Não autenticado" }, 401);
  }

  // client com service role — pra tudo que precisa ignorar RLS ou mexer em auth
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: callerMember, error: callerMemberError } = await adminClient
    .from("members")
    .select("is_admin")
    .eq("auth_user_id", callerData.user.id)
    .maybeSingle();

  if (callerMemberError || !callerMember?.is_admin) {
    return jsonResponse({ error: "Só admin pode resetar senha de membro" }, 403);
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
    .select("id, coupon_code, name, auth_user_id")
    .eq("id", body.member_id)
    .maybeSingle();

  if (targetError || !targetMember) {
    return jsonResponse({ error: "Membro não encontrado" }, 404);
  }

  if (!targetMember.auth_user_id) {
    return jsonResponse({ error: "Esse membro ainda não tem login criado" }, 400);
  }

  const tempPassword = randomTempPassword();

  const { error: updateError } = await adminClient.auth.admin.updateUserById(targetMember.auth_user_id, {
    password: tempPassword,
    user_metadata: { must_change_password: true },
  });

  if (updateError) {
    console.error("Erro ao resetar senha:", updateError);
    return jsonResponse({ error: updateError.message ?? "Erro interno ao resetar senha" }, 500);
  }

  return jsonResponse({ ok: true, coupon_code: targetMember.coupon_code, name: targetMember.name, temp_password: tempPassword });
});
