import type { FunctionsError } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";

// Chama uma Edge Function admin-gated garantindo primeiro que o access token
// da sessão está válido. No celular, quando o app fica em segundo plano
// (ex: trocou pro WhatsApp) por tempo suficiente, o token expira e o
// refresh automático do supabase-js só dispara quando a aba volta ao foco —
// se a pessoa clicar num botão antes desse refresh terminar, a function
// recebe um token vencido e devolve 401 "Não autenticado", mesmo a pessoa
// estando logada de verdade. `getSession()` verifica a validade e renova
// sozinho antes de devolver, então chamar ela antes do invoke evita a
// corrida.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function invokeAdminFunction<T = any>(
  name: string,
  body?: Record<string, unknown>,
): Promise<{ data: T | null; error: FunctionsError | null }> {
  await supabase.auth.getSession();
  return supabase.functions.invoke<T>(name, body ? { body } : undefined);
}

// supabase-js só preenche `data` quando a Edge Function responde 2xx — em
// erro (4xx/5xx), `data` vem null e a mensagem de verdade fica escondida
// dentro de `error.context` (a Response crua). Sem isso, qualquer erro vira
// "erro desconhecido" na tela, mesmo a function tendo devolvido um motivo
// claro tipo { error: "..." }.
export async function extractFunctionErrorMessage(error: FunctionsError | null, data: unknown): Promise<string | null> {
  const dataError = (data as { error?: string } | null)?.error;
  if (dataError) return dataError;

  if (error && "context" in error && error.context instanceof Response) {
    try {
      const body = await error.context.clone().json();
      if (body?.error) return body.error as string;
    } catch {
      // corpo não era JSON, ignora e cai no fallback abaixo
    }
  }

  if (error?.message) return error.message;

  return null;
}
