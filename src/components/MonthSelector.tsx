import { formatCycleMonthLabel } from "../lib/date";

interface MonthSelectorProps {
  months: string[]; // cycle_month (YYYY-MM-DD), mais recente primeiro
  selected: string;
  onChange: (month: string) => void;
}

export function MonthSelector({ months, selected, onChange }: MonthSelectorProps) {
  if (months.length <= 1) return null;

  return (
    <select className="mm-month-select" value={selected} onChange={(e) => onChange(e.target.value)}>
      {months.map((month) => (
        <option key={month} value={month}>
          {formatCycleMonthLabel(month)}
        </option>
      ))}
    </select>
  );
}
