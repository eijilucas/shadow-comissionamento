import { useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "../lib/supabaseClient";

export function ForceChangePassword() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 6) {
      setError("A senha precisa ter pelo menos 6 caracteres.");
      return;
    }
    if (password !== confirmPassword) {
      setError("As senhas não são iguais.");
      return;
    }

    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({
      password,
      data: { must_change_password: false },
    });
    setLoading(false);

    if (updateError) {
      setError("Não deu pra trocar a senha. Tenta de novo.");
    }
  }

  return (
    <div className="mm-auth-shell">
      <div className="mm-auth-card">
        <div className="mm-auth-brand">
          <img src="/logo-m.png" alt="Shadow of the Fallen" className="mm-logo-mark" style={{ width: 40, height: 40 }} />
          <span className="mm-wordmark">Shadow of the Fallen</span>
        </div>

        <div className="mm-label" style={{ marginBottom: 16, textAlign: "center" }}>
          Essa é sua senha temporária. Crie uma senha nova pra continuar.
        </div>

        <form onSubmit={handleSubmit}>
          {error && <div className="mm-auth-error">{error}</div>}

          <div className="mm-field">
            <label className="mm-label" htmlFor="new-password">
              Nova senha
            </label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <div className="mm-field">
            <label className="mm-label" htmlFor="confirm-password">
              Confirmar nova senha
            </label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>

          <button type="submit" className="mm-btn-primary" disabled={loading}>
            {loading ? "Salvando..." : "Salvar e continuar"}
          </button>
        </form>
      </div>
    </div>
  );
}
