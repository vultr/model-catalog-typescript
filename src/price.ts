const DECIMAL = /^(-?)(\d*)(?:\.(\d*))?$/;

// cost_usd is a decimal string in USD per unit. Shifting the decimal point keeps
// "0.0000001" exact (0.1) where float math gives 0.09999999999999999.
export function usdPerMillion(costUsd: string): number {
  const match = DECIMAL.exec(costUsd.trim());
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) {
    return Number(costUsd) * 1_000_000;
  }
  const sign = match[1] ?? "";
  const whole = match[2] ?? "";
  const fraction = (match[3] ?? "").padEnd(6, "0");
  return Number(`${sign}${whole}${fraction.slice(0, 6)}.${fraction.slice(6) || "0"}`);
}
