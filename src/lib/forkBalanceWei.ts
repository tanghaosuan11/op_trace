/** Fork Balance patch: decimal amount + unit → wei as 0x-prefixed hex for the Rust side. */

export type ForkBalanceUnit = "wei" | "gwei" | "eth";

function strip(s: string): string {
  return s.trim().replace(/\s+/g, "");
}

/** Integer decimal string → BigInt, no sign, optional single `.` rejected for wei-only path */
function assertNonNegativeDecimal(s: string): void {
  if (!s.length) throw new Error("Amount is empty");
  if (s.startsWith("-")) throw new Error("Amount cannot be negative");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Use decimal digits only (optional one `.`)");
}

/** `1.234` ETH → wei */
function ethDecimalToWei(s: string): bigint {
  const t = strip(s);
  assertNonNegativeDecimal(t);
  const parts = t.split(".");
  if (parts.length > 2) throw new Error("Invalid number");
  const intP = parts[0] || "0";
  const fracP = parts[1] ?? "";
  if (fracP.length > 18) throw new Error("At most 18 decimal places for ETH");
  const intWei = BigInt(intP) * 10n ** 18n;
  const fracWei = fracP.length
    ? BigInt(fracP) * 10n ** BigInt(18 - fracP.length)
    : 0n;
  return intWei + fracWei;
}

/** `1.5` Gwei → wei */
function gweiDecimalToWei(s: string): bigint {
  const t = strip(s);
  assertNonNegativeDecimal(t);
  const parts = t.split(".");
  if (parts.length > 2) throw new Error("Invalid number");
  const intP = parts[0] || "0";
  const fracP = parts[1] ?? "";
  if (fracP.length > 9) throw new Error("At most 9 decimal places for Gwei");
  const intWei = BigInt(intP) * 10n ** 9n;
  const fracWei = fracP.length
    ? BigInt(fracP) * 10n ** BigInt(9 - fracP.length)
    : 0n;
  return intWei + fracWei;
}

function weiDecimalToWei(s: string): bigint {
  const t = strip(s);
  assertNonNegativeDecimal(t);
  if (t.includes(".")) throw new Error("Wei amount must be an integer");
  return BigInt(t);
}

/**
 * Converts user decimal input to wei, then to lowercase `0x` + hex (matches backend `parse_u256_hex`).
 */
export function forkBalanceDecimalToWeiHex(amount: string, unit: ForkBalanceUnit): string {
  let wei: bigint;
  switch (unit) {
    case "wei":
      wei = weiDecimalToWei(amount);
      break;
    case "gwei":
      wei = gweiDecimalToWei(amount);
      break;
    case "eth":
      wei = ethDecimalToWei(amount);
      break;
    default:
      throw new Error("Unknown unit");
  }
  const hex = wei.toString(16);
  return `0x${hex}`;
}
