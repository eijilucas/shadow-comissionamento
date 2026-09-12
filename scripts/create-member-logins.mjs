// Cria as contas de login (Supabase Auth) de todos os membros (incluindo
// admins) que ainda não têm uma, todas com a MESMA senha temporária, e já
// vincula o auth_user_id na tabela `members`. Usa o e-mail já cadastrado na
// coluna `members.email` de cada um (sintético baseado no cupom pros membros
// comuns, ou um e-mail real no caso de admin) — ver src/lib/auth.ts.
//
// No primeiro login, o painel força a pessoa a trocar a senha antes de ver
// qualquer coisa (ver src/pages/ForceChangePassword.tsx) — a conta é criada
// com user_metadata.must_change_password = true, e isso só vira false depois
// que ela mesma define uma senha nova.
//
// Como rodar:
//   1. Pegue a service role key em Project Settings > API > service_role
//      (NUNCA cole essa key no chat nem comite ela em lugar nenhum).
//   2. Rode no terminal, dentro da pasta do projeto:
//
//        SUPABASE_URL=https://<seu-ref>.supabase.co \
//        SUPABASE_SERVICE_ROLE_KEY=<cole a service role key aqui> \
//        TEMP_PASSWORD=<escolha a senha temporária, ou deixe de fora pro padrão> \
//        node scripts/create-member-logins.mjs
//
//   3. Ao final, a lista de cupons criados fica em member-credentials.csv
//      (já no .gitignore) — a senha temporária é a mesma pra todos, mostrada
//      no terminal ao final. Avise os membros: "usuário = seu cupom, senha =
//      <a que apareceu>, e assim que logar ele pede pra trocar".
//   4. Pode rodar de novo sem problema: só cria conta pra quem ainda não tem
//      (auth_user_id is null), não duplica ninguém.

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEMP_PASSWORD = process.env.TEMP_PASSWORD || "shadowfallen2026";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nas variáveis de ambiente antes de rodar (veja o comentário no topo deste arquivo).",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function main() {
  const { data: members, error } = await supabase
    .from("members")
    .select("id, name, coupon_code, email")
    .is("auth_user_id", null)
    .eq("active", true);

  if (error) throw error;

  if (!members || members.length === 0) {
    console.log("Nenhum membro pendente de login — todo mundo já tem conta.");
    return;
  }

  console.log(`Criando login para ${members.length} membro(s) com a senha temporária "${TEMP_PASSWORD}"...`);
  const results = [];

  for (const member of members) {
    if (!member.email) {
      console.error(`Pulei ${member.coupon_code}: sem e-mail cadastrado.`);
      continue;
    }

    const { data: created, error: createError } = await supabase.auth.admin.createUser({
      email: member.email,
      password: TEMP_PASSWORD,
      email_confirm: true,
      user_metadata: { must_change_password: true },
    });

    if (createError) {
      console.error(`Falhou ${member.coupon_code}: ${createError.message}`);
      continue;
    }

    const { error: updateError } = await supabase
      .from("members")
      .update({ auth_user_id: created.user.id })
      .eq("id", member.id);

    if (updateError) {
      console.error(`Criou o login mas falhou ao vincular ${member.coupon_code}: ${updateError.message}`);
      continue;
    }

    results.push({ coupon: member.coupon_code, name: member.name });
    console.log(`OK: ${member.coupon_code}`);
  }

  if (results.length > 0) {
    const csv = ["cupom,nome", ...results.map((r) => `${r.coupon},${r.name}`)].join("\n");
    writeFileSync("member-credentials.csv", csv);
    console.log(
      `\n${results.length} conta(s) criada(s). Senha temporária pra todos: "${TEMP_PASSWORD}" (peça pra trocarem no primeiro login).\nLista de cupons criados em member-credentials.csv.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
