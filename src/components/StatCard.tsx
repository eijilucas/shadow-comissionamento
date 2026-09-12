interface StatCardProps {
  label: string;
  value: string;
  accent?: boolean;
}

export function StatCard({ label, value, accent }: StatCardProps) {
  return (
    <div className="mm-stat-card">
      <div className="mm-label">{label}</div>
      <div className={`mm-stat-value${accent ? " mm-accent" : ""}`}>{value}</div>
    </div>
  );
}
