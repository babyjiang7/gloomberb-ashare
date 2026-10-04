export interface ResearchListing { symbol: string; code: string; exchange: "SSE" | "SZSE" | "BJSE"; name: string }
const venues: Record<string, ResearchListing["exchange"]> = {
  SH: "SSE", SS: "SSE", SSE: "SSE", SHH: "SSE", SHG: "SSE", XSHG: "SSE", SHANGHAI: "SSE",
  SZ: "SZSE", SZSE: "SZSE", SHE: "SZSE", XSHE: "SZSE", SHENZHEN: "SZSE",
  // BSE is the host's Mumbai exchange. Beijing has its own plugin route.
  BJ: "BJSE", BJSE: "BJSE", BEIJING: "BJSE",
};

/** A routing identity, not a promise that the host has financial data for this listing. */
export function resolveResearchListing(input: string, exchange?: string): ResearchListing | null {
  if (typeof input !== "string" || (exchange !== undefined && typeof exchange !== "string")) return null;
  const parts = input.trim().toUpperCase().split(":");
  if (parts.length > 2 || !parts[0] || (parts.length === 2 && !parts[1])) return null;
  const match = /^(\d{6})(?:\.(SH|SS|SZ|BJ))?$/.exec(parts[0]);
  if (!match) return null;
  const code = match[1]!;
  const venue = /^(60|68)\d{4}$/.test(code) ? "SSE" : /^(00|30)\d{4}$/.test(code) ? "SZSE"
    : /^920\d{3}$/.test(code) ? "BJSE" : null;
  if (!venue) return null;
  const supplied = [match[2], parts[1], exchange?.trim().toUpperCase()].filter((value): value is string => value !== undefined);
  if (supplied.some((value) => venues[value] !== venue)) return null;
  const symbol = `${code}.${venue === "SSE" ? "SH" : venue === "SZSE" ? "SZ" : "BJ"}`;
  // Prefixes identify the route only. A company name requires current issuer evidence.
  return { symbol, code, exchange: venue, name: code };
}

export function requireResearchListing(input: string, exchange?: string): ResearchListing {
  const listing = resolveResearchListing(input, exchange);
  if (!listing) throw new Error("请输入有效的 A 股代码，并使用匹配的交易所。北交所请使用现行 920 代码。");
  return listing;
}
