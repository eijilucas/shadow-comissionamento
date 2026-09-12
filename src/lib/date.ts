// Primeiro dia do mês corrente, no formato YYYY-MM-DD — mesma convenção
// usada em cycles.cycle_month (ver schema.sql).
export function currentCycleMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

// Primeiro dia do mês seguinte a um cycle_month (YYYY-MM-DD) — usado como
// limite superior (exclusivo) ao filtrar vendas daquele mês por sale_date.
export function nextCycleMonth(cycleMonth: string = currentCycleMonth()): string {
  const [year, month] = cycleMonth.split("-").map(Number);
  const next = new Date(year, month, 1); // month já é 1-indexed no input, então isso pula um mês à frente
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`;
}

const monthLabelFormatter = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" });

// "2026-08-01" -> "agosto de 2026"
export function formatCycleMonthLabel(cycleMonth: string): string {
  const [year, month] = cycleMonth.split("-").map(Number);
  return monthLabelFormatter.format(new Date(year, month - 1, 1));
}
