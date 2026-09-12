// Reseta a senha de UM membro específico (pelo cupom) pra uma senha
// temporária e marca must_change_password = true — útil pra testar o fluxo
// de troca obrigatória de senha numa conta que já existe (ex: a de admin),
// sem precisar recriar ninguém.
//
// Rode assim (mesma lógica do create-member-logins.mjs — com a service role
// key na mão):
//
//   SUPABASE_URL=https://<seu-ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<cole a service role key aqui> \
//   node scripts/reset-member-password.mjs SEUCUPOM [senha-temporaria-opcional]

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEMP_PASSWORD = process.argv[3] || process.env.TEMP_PASSWORD || "shadowfallen2026";
const couponCode = process.argv[2];

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nas variáveis de ambiente antes de rodar.");
  process.exit(1);
}

if (!couponCode) {
  console.error("Uso: node scripts/reset-member-password.mjs <CUPOM> [senha-temporaria-opcional]");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function main() {
  const { data: member, error } = await supabase
    .from("members")
    .select("id, name, coupon_code, auth_user_id")
    .eq("coupon_code", couponCode.toUpperCase())
    .maybeSingle();

  if (error) throw error;

  if (!member) {
    console.error(`Nenhum membro com o cupom "${couponCode}".`);
    process.exit(1);
  }

  if (!member.auth_user_id) {
    console.error(`"${member.coupon_code}" ainda não tem login criado — use o create-member-logins.mjs primeiro.`);
    process.exit(1);
  }

  const { error: updateError } = await supabase.auth.admin.updateUserById(member.auth_user_id, {
    password: TEMP_PASSWORD,
    user_metadata: { must_change_password: true },
  });

  if (updateError) {
    console.error(`Falhou: ${updateError.message}`);
    process.exit(1);
  }

  console.log(`OK: senha de "${member.coupon_code}" (${member.name}) resetada pra "${TEMP_PASSWORD}". Vai pedir pra trocar no próximo login.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
