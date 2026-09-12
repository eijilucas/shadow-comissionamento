// ============================================================================
// Edge Function: pay-commission-pix
// Chamada pelo botão "Enviar PIX" / "Enviar PIX para todos" no painel admin
// (seção "Pagamento de Comissão"). Pra cada ciclo pendente informado: chama
// a API de Transferências do Asaas (POST /v3/transfers) mandando o valor da
// comissão pra chave PIX do membro, e só marca cycles.commission_paid =
// true se a transferência foi aceita.
//
// Asaas libera transferência via chave PIX numa API bem mais simples, com
// só uma API key.
//
// Deploy:
//   npx supabase functions deploy pay-commission-pix --project-ref <seu-ref>
//
// Secret necessário (Configurações > Integrações > API Key, no painel do
// Asaas — sandbox ou produção, ver detecção automática abaixo):
//   npx supabase secrets set ASAAS_API_KEY=xxxxx --project-ref <seu-ref>
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const ASAAS_API_KEY = Deno.env.get("ASAAS_API_KEY") ?? "";

// Chave de sandbox começa com "$aact_hmlg_", produção com "$aact_prod_" —
// detecta sozinho pra evitar mandar PIX de teste pra API de produção (ou
// vice-versa) por engano de configuração.
const ASAAS_BASE_URL = ASAAS_API_KEY.startsWith("$aact_hmlg_")
  ? "https://api-sandbox.asaas.com/v3"
  : "https://api.asaas.com/v3";

interface PayoutTarget {
  cycleId: string;
  memberName: string;
  pixKey: string;
  pixKeyType: string;
  amount: number;
}

interface PayoutResult {
  cycleId: string;
  memberName: string;
  ok: boolean;
  reason?: string;
}

async function sendPayout(target: PayoutTarget): Promise<PayoutResult> {
  try {
    const res = await fetch(`${ASAAS_BASE_URL}/transfers`, {
      method: "POST",
      headers: {
        access_token: ASAAS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        value: target.amount,
        pixAddressKey: target.pixKey,
        pixAddressKeyType: target.pixKeyType,
        operationType: "PIX",
        description: `Comissão Shadow of the Fallen — ${target.memberName}`,
        externalReference: `commission-${target.cycleId}`,
      }),
    });

    const resBody = await res.json().catch(() => null);

    if (!res.ok) {
      console.error(`Payout falhou pra ${target.memberName}:`, res.status, resBody);
      const reason = resBody?.errors?.[0]?.description ?? `Asaas recusou (${res.status})`;
      return { cycleId: target.cycleId, memberName: target.memberName, ok: false, reason };
    }

    // status vem PENDING na hora — o Asaas processa async e confirma depois
    // via webhook, mas já aceitou a ordem de transferência.
    return { cycleId: target.cycleId, memberName: target.memberName, ok: true };
  } catch (err) {
    console.error(`Erro de rede no payout pra ${target.memberName}:`, err);
    return { cycleId: target.cycleId, memberName: target.memberName, ok: false, reason: "Erro de rede ao chamar o Asaas" };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!ASAAS_API_KEY) {
    return jsonResponse({ error: "API Key do Asaas ainda não configurada." }, 400);
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
    return jsonResponse({ error: "Só admin pode disparar pagamento de comissão" }, 403);
  }

  let body: { cycle_ids?: string[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "JSON inválido" }, 400);
  }

  if (!body.cycle_ids || body.cycle_ids.length === 0) {
    return jsonResponse({ error: "cycle_ids é obrigatório" }, 400);
  }

  const { data: cycles, error: cyclesError } = await adminClient
    .from("cycles")
    .select("id, commission_amount, commission_paid, members(id, name, pix_key, pix_key_type)")
    .in("id", body.cycle_ids);

  if (cyclesError || !cycles) {
    return jsonResponse({ error: "Erro ao buscar os ciclos" }, 500);
  }

  const targets: PayoutTarget[] = [];
  const skipped: PayoutResult[] = [];

  for (const c of cycles as unknown as Array<{
    id: string;
    commission_amount: number;
    commission_paid: boolean;
    members: { id: string; name: string; pix_key: string | null; pix_key_type: string | null };
  }>) {
    if (c.commission_paid) continue;
    if (!c.members.pix_key || !c.members.pix_key_type) {
      skipped.push({ cycleId: c.id, memberName: c.members.name, ok: false, reason: "Sem chave PIX (ou tipo) cadastrada" });
      continue;
    }
    targets.push({
      cycleId: c.id,
      memberName: c.members.name,
      pixKey: c.members.pix_key,
      pixKeyType: c.members.pix_key_type,
      amount: c.commission_amount,
    });
  }

  const results: PayoutResult[] = [...skipped];

  for (const target of targets) {
    const result = await sendPayout(target);
    results.push(result);

    if (result.ok) {
      await adminClient
        .from("cycles")
        .update({ commission_paid: true, commission_paid_at: new Date().toISOString() })
        .eq("id", target.cycleId);
    }
  }

  const allOk = results.every((r) => r.ok);
  return jsonResponse({ ok: allOk, results });
});
