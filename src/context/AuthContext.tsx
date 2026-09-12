import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabaseClient";
import type { Member } from "../types";

interface AuthContextValue {
  session: Session | null;
  member: Member | null;
  loading: boolean;
  mustChangePassword: boolean;
  signOut: () => Promise<void>;
  refreshMember: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [member, setMember] = useState<Member | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadMember(userId: string) {
    const { data } = await supabase.from("members").select("*").eq("auth_user_id", userId).maybeSingle();
    setMember(data ?? null);
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session?.user) {
        loadMember(data.session.user.id).finally(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (newSession?.user) {
        loadMember(newSession.user.id);
      } else {
        setMember(null);
      }
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
  }

  async function refreshMember() {
    if (session?.user) {
      await loadMember(session.user.id);
    }
  }

  // Setado em user_metadata na criação da conta (ver scripts/create-member-logins.mjs)
  // quando o membro ainda está com a senha temporária compartilhada.
  const mustChangePassword = session?.user?.user_metadata?.must_change_password === true;

  return (
    <AuthContext.Provider value={{ session, member, loading, mustChangePassword, signOut, refreshMember }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth deve ser usado dentro de AuthProvider");
  return ctx;
}
