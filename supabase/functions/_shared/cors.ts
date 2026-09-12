// Cabeçalhos de CORS compartilhados por todas as Edge Functions chamadas
// direto do navegador (painel admin). Sem isso, o preflight (OPTIONS) que o
// navegador manda antes de POST com header Authorization/apikey leva 405 e a
// requisição real nunca sai — aparece como "Failed to send a request to the
// Edge Function" no supabase-js, sem nenhum log do lado da function.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}
