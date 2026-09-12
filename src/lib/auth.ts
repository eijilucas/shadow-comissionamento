// Login aceita usuário (cupom) OU e-mail real (admins já têm conta com
// e-mail de verdade). Se não tiver "@", assume que é um cupom e monta o
// mesmo e-mail sintético usado no banco (ver
// supabase/migrations/20260912000001_init.sql e
// scripts/create-member-logins.mjs) -- precisa ficar igual ao
// SYNTHETIC_LOGIN_DOMAIN em supabase/functions/shopify-webhook/index.ts.
export const SYNTHETIC_LOGIN_DOMAIN = "sotf.internal";

export function resolveLoginEmail(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("@")) return trimmed;
  return `${trimmed.toLowerCase()}@${SYNTHETIC_LOGIN_DOMAIN}`;
}
