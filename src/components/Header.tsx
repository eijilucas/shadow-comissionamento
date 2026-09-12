import { useTheme } from "../context/ThemeContext";

interface HeaderProps {
  memberName?: string;
  couponCode?: string;
  onSignOut: () => void;
  rightSlot?: React.ReactNode;
  // Efeito na logo quando o membro já garantiu todas as peças do drop no
  // ciclo atual — brilho + reflexo passando por cima do símbolo.
  celebrate?: boolean;
}

export function Header({ memberName, couponCode, onSignOut, rightSlot, celebrate }: HeaderProps) {
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="mm-header">
      <div className="mm-header-brand">
        <div className={`mm-logo-mark-wrap${celebrate ? " mm-logo-celebrate" : ""}`}>
          <img src="/logo-m.png" alt="Shadow of the Fallen" className="mm-logo-mark" />
        </div>
        <span className="mm-wordmark">Shadow of the Fallen</span>
      </div>

      <div className="mm-header-actions">
        {(memberName || couponCode) && (
          <div className="mm-header-member">
            {memberName && <div className="mm-member-name">{memberName}</div>}
            {couponCode && <div className="mm-member-coupon">{couponCode}</div>}
          </div>
        )}
        <div className="mm-header-buttons">
          {rightSlot}
          <button type="button" className="mm-link-btn" onClick={toggleTheme}>
            {theme === "dark" ? "Modo claro" : "Modo escuro"}
          </button>
          <button type="button" className="mm-link-btn" onClick={onSignOut}>
            Sair
          </button>
        </div>
      </div>
    </header>
  );
}
