import { useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "../lib/supabaseClient";
import { useTheme } from "../context/ThemeContext";
import { resolveLoginEmail } from "../lib/auth";

export function Login() {
  const { theme, toggleTheme } = useTheme();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: resolveLoginEmail(identifier),
      password,
    });
    setLoading(false);
    if (signInError) {
      setError("Usuário ou senha inválidos.");
    }
  }

  return (
    <div className="mm-auth-shell">
      <div className="mm-auth-card">
        <div className="mm-auth-brand">
          <img src="/logo-m.png" alt="Shadow of the Fallen" className="mm-logo-mark" style={{ width: 40, height: 40 }} />
          <span className="mm-wordmark">Shadow of the Fallen</span>
        </div>

        <form onSubmit={handleSubmit}>
          {error && <div className="mm-auth-error">{error}</div>}

          <div className="mm-field">
            <label className="mm-label" htmlFor="identifier">
              Usuário
            </label>
            <input
              id="identifier"
              type="text"
              autoComplete="username"
              required
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
            />
          </div>

          <div className="mm-field">
            <label className="mm-label" htmlFor="password">
              Senha
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <button type="submit" className="mm-btn-primary" disabled={loading}>
            {loading ? "Entrando..." : "Entrar"}
          </button>
        </form>

        <button
          type="button"
          className="mm-link-btn"
          style={{ width: "100%", marginTop: 16 }}
          onClick={toggleTheme}
        >
          {theme === "dark" ? "Modo claro" : "Modo escuro"}
        </button>
      </div>
    </div>
  );
}
