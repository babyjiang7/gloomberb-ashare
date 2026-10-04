import { expect, test } from "bun:test";
import { requireResearchListing, resolveResearchListing } from "./research-symbols";

test("current Beijing A-share codes have an independent routing identity", () => {
  for (const input of ["920185", "920185.bj", " 920185.BJ ", "920185:BJ", "920185:BJSE", "920185:BEIJING"]) {
    expect(requireResearchListing(input)).toEqual({ symbol: "920185.BJ", code: "920185", exchange: "BJSE", name: "920185" });
  }
  expect(requireResearchListing("920078.BJ", "BJSE").symbol).toBe("920078.BJ");
  expect(requireResearchListing("920171", "BEIJING").exchange).toBe("BJSE");
});

test("Beijing cannot alias Mumbai, other A-share venues, old migrated codes or other instruments", () => {
  for (const input of ["920185:BSE", "920185.BO", "920185.SH", "920185.SZ", "920185.BJ:SSE", "600519.BJ", "300059:BJ", "430047.BJ", "835185.BJ", "930185.BJ", "920185:XBOM"]) {
    expect(resolveResearchListing(input)).toBeNull();
  }
  expect(resolveResearchListing("920185.BJ", "BSE")).toBeNull();
  expect(resolveResearchListing("920185", "SZSE")).toBeNull();
  expect(() => requireResearchListing("835185")).toThrow("现行 920 代码");
});

test("Shanghai and Shenzhen remain generic while explicit conflicting venues fail", () => {
  for (const input of ["600000", "605090", "688981"]) expect(requireResearchListing(input).exchange).toBe("SSE");
  for (const input of ["000001", "002594", "003816", "300059", "301308"]) expect(requireResearchListing(input).exchange).toBe("SZSE");
  expect(requireResearchListing("688981.SS:XSHG").symbol).toBe("688981.SH");
  expect(requireResearchListing("300059.SZ:XSHE").symbol).toBe("300059.SZ");
  for (const input of ["AAPL", "00700.HK", "510300.SH", "200001.SZ", "900901.SH", "600000.SZ", "002594.SH", "601138:", "920185.BJ:BSE"]) {
    expect(resolveResearchListing(input)).toBeNull();
  }
});

test("routing never assigns a sample company name without current issuer verification", () => {
  for (const code of ["600519", "601138", "605090", "601021", "000001", "300059", "301219"]) {
    expect(requireResearchListing(code).name).toBe(code);
  }
});
