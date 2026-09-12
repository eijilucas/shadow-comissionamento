import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";
import { Login } from "./pages/Login";
import { ForceChangePassword } from "./pages/ForceChangePassword";
import { MemberDashboard } from "./pages/MemberDashboard";
import { AdminDashboard } from "./pages/AdminDashboard";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session, member, loading, mustChangePassword } = useAuth();

  if (loading) return <div className="mm-loading-shell">Carregando...</div>;
  if (!session) return <Navigate to="/login" replace />;
  if (mustChangePassword) return <ForceChangePassword />;
  if (!member) {
    return (
      <div className="mm-loading-shell">
        Conta autenticada, mas sem cadastro de membro vinculado. Peça ao admin para associar seu login.
      </div>
    );
  }
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { member } = useAuth();
  if (!member?.is_admin) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  const { session, loading } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={loading ? <div className="mm-loading-shell">Carregando...</div> : session ? <Navigate to="/dashboard" replace /> : <Login />} />
      <Route
        path="/dashboard"
        element={
          <RequireAuth>
            <MemberDashboard />
          </RequireAuth>
        }
      />
      <Route
        path="/admin"
        element={
          <RequireAuth>
            <RequireAdmin>
              <AdminDashboard />
            </RequireAdmin>
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </ThemeProvider>
  );
}
