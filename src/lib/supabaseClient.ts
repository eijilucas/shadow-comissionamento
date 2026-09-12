import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY não configurados. Copie .env.example para .env e preencha os valores.",
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
