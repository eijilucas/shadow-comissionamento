// Cálculo de gift card e comissão é feito no banco (ver
// supabase/migrations/20260912000001_init.sql -> calculate_cycle_rewards) e
// chega pronto na tabela `cycles`. Este arquivo só existe para o que é
// puramente de exibição: progresso percentual até cada marco do ciclo,
// usado na barra serrilhada do painel.
//
// O rótulo de "comissão %" é parametrizado a partir de app_config (buscado em
// MemberDashboard). Os valores dos gift cards são fixos (ponto de partida
// herdado do projeto irmão Mental Madness -- ajuste livremente) e batem com
// calculate_cycle_rewards na migration -- se mudar lá, muda aqui também.

// Marcos ACUMULATIVOS de gift card (soma ao longo do mês, um único gift card
// no fechamento). 6 vendas fica no meio como o marco da comissão de 5%.
export const GIFT_CARD_TIERS: { sales: number; value: number }[] = [
  { sales: 3, value: 100 },
  { sales: 5, value: 150 },
  { sales: 7, value: 150 },
  { sales: 10, value: 250 },
  { sales: 15, value: 400 },
];

// Marcos mostrados na barra (inclui o 6, que é o da comissão, não de gift card).
export const CYCLE_MILESTONES = [3, 5, 6, 7, 10, 15] as const;

export interface MilestoneProgress {
  milestone: number;
  displayNumber: string;
  reached: boolean;
  label: string;
}

const MILESTONE_DISPLAY: Record<number, string> = {
  3: "3",
  5: "5",
  6: "6",
  7: "7",
  10: "10",
  15: "15+",
};

const currencyFormatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

// "0.05" -> "5%", "0.035" -> "3.5%"
export function formatCommissionPct(commissionRate: number): string {
  const pct = Math.round(commissionRate * 10000) / 100;
  return `${pct}%`;
}

// Valor total de gift card acumulado até uma dada quantidade de vendas no mês.
export function accumulatedGiftCardValue(salesCount: number): number {
  return GIFT_CARD_TIERS.filter((t) => salesCount >= t.sales).reduce((sum, t) => sum + t.value, 0);
}

function milestoneLabels(commissionRate: number): Record<number, string> {
  const pct = formatCommissionPct(commissionRate);
  return {
    3: `Gift card de ${currencyFormatter.format(100)}`,
    5: `+ ${currencyFormatter.format(150)} de gift card`,
    6: `${pct} de comissão`,
    7: `+ ${currencyFormatter.format(150)} de gift card`,
    10: `+ ${currencyFormatter.format(250)} de gift card`,
    15: `+ ${currencyFormatter.format(400)} de gift card (total: ${currencyFormatter.format(1050)})`,
  };
}

export function milestoneProgress(salesCount: number, commissionRate: number): MilestoneProgress[] {
  const labels = milestoneLabels(commissionRate);
  return CYCLE_MILESTONES.map((milestone) => ({
    milestone,
    displayNumber: MILESTONE_DISPLAY[milestone],
    reached: salesCount >= milestone,
    label: labels[milestone],
  }));
}

// Percentual de preenchimento da barra do ciclo (satura em 100% após o
// último marco, 15 vendas).
export function cycleProgressPercent(salesCount: number): number {
  const cap = CYCLE_MILESTONES[CYCLE_MILESTONES.length - 1];
  return Math.min(100, Math.round((salesCount / cap) * 100));
}
