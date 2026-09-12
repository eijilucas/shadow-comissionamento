// ============================================================================
// Cliente mínimo do Resend (API de e-mail transacional).
//
// Secret esperado: RESEND_API_KEY
// ============================================================================

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

// Precisa ser um domínio verificado na conta Resend -- ajuste se o domínio
// verificado for outro.
const FROM_ADDRESS = "Shadow of the Fallen <naoresponda@shadowofthefallen.com>";

export class ResendError extends Error {}

export async function sendEmail(params: { to: string; subject: string; html: string }): Promise<void> {
  if (!RESEND_API_KEY) throw new ResendError("RESEND_API_KEY não configurado");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      // "charset=utf-8" explícito -- sem isso, os testes mostraram acento
      // virando "�" mesmo com <meta charset="utf-8"> no HTML (o meta tag
      // só ajuda se os BYTES já chegaram certos).
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [params.to],
      subject: params.subject,
      html: params.html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new ResendError(`Falha ao enviar e-mail via Resend (HTTP ${res.status}): ${body}`);
  }
}
