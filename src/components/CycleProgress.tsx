import { useEffect, useRef, useState } from "react";
import { cycleProgressPercent, formatCommissionPct, milestoneProgress } from "../lib/rewards";

interface CycleProgressProps {
  salesCount: number;
  commissionRate: number;
}

const currencyFormatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function CycleProgress({ salesCount, commissionRate }: CycleProgressProps) {
  const percent = cycleProgressPercent(salesCount);
  const milestones = milestoneProgress(salesCount, commissionRate);
  const pct = formatCommissionPct(commissionRate);

  // Começa em 0 e anima até o valor real a cada mudança — tanto no primeiro
  // load quanto quando uma venda nova chega via realtime.
  const [animatedPercent, setAnimatedPercent] = useState(0);
  const frame = useRef<number | undefined>(undefined);

  useEffect(() => {
    setAnimatedPercent(0);
    frame.current = requestAnimationFrame(() => {
      frame.current = requestAnimationFrame(() => setAnimatedPercent(percent));
    });
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [percent]);

  return (
    <section className="mm-progress-section">
      <h2 className="mm-section-title">Progresso do Ciclo</h2>
      <div className="mm-label">{salesCount} vendas neste mês</div>

      <div className="mm-progress-track">
        <div className="mm-progress-fill" style={{ width: `${animatedPercent}%` }} />
      </div>

      <div className="mm-progress-milestones" style={{ gridTemplateColumns: `repeat(${milestones.length}, 1fr)` }}>
        {milestones.map((m) => (
          <div className="mm-milestone" key={m.milestone}>
            <div className={`mm-milestone-number${m.reached ? "" : " mm-milestone-dim"}`}>{m.displayNumber}</div>
            <div className="mm-milestone-label">{m.label}</div>
          </div>
        ))}
      </div>

      <div className="mm-rewards-explainer">
        <div className="mm-label">Condições para receber gift card e comissão</div>
        <ul className="mm-rewards-list">
          <li>
            <strong>3 vendas</strong> = gift card de {currencyFormatter.format(100)}.
          </li>
          <li>
            <strong>5 vendas</strong> = + {currencyFormatter.format(150)} de gift card.
          </li>
          <li>
            <strong>6 vendas</strong> = {pct} de comissão (sobre o valor do mês inteiro).
          </li>
          <li>
            <strong>7 vendas</strong> = + {currencyFormatter.format(150)} de gift card.
          </li>
          <li>
            <strong>10 vendas</strong> = + {currencyFormatter.format(250)} de gift card.
          </li>
          <li>
            <strong>15+ vendas</strong> = + {currencyFormatter.format(400)} de gift card (total de {currencyFormatter.format(1050)}).
          </li>
        </ul>
        <div className="mm-label" style={{ marginTop: 8 }}>
          Os valores de gift card vão somando ao longo do mês — no fechamento você recebe um único gift card com o total.
        </div>
      </div>
    </section>
  );
}
