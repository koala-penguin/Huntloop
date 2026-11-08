import { describe, expect, it } from "vitest";
import { formatUsd, salaryLine } from "@/lib/format";

const label = (basis: string) => ({ base: "base", base_plus_super: "plus super", package: "package incl. super" })[basis] ?? basis;

describe("salary line", () => {
  it("doesn't repeat the basis when the posting's own text already says it", () => {
    const salary = { text: "$180,000 – $200,000 plus super and equity.", min: 180000, max: 200000, currency: "AUD", basis: "base_plus_super" };
    expect(salaryLine(salary, "en-AU", label)).toBe("$180,000 – $200,000 plus super and equity.");
  });

  it("adds the basis to a formatted range", () => {
    const salary = { text: null, min: 150000, max: 170000, currency: "AUD", basis: "base_plus_super" };
    expect(salaryLine(salary, "en-AU", label)).toBe("AUD 150,000 – 170,000 · plus super");
  });

  it("leaves out an unknown basis and handles no salary", () => {
    expect(salaryLine({ text: "Competitive", min: null, max: null, currency: null, basis: "unknown" }, "en-AU", label)).toBe("Competitive");
    expect(salaryLine({ text: null, min: null, max: null, currency: null, basis: "base" }, "en-AU", label)).toBeNull();
    expect(salaryLine(null, "en-AU", label)).toBeNull();
  });
});

describe("formatUsd", () => {
  it("formats dollars and fractions of a cent", () => {
    expect(formatUsd(1.5, "en-US")).toBe("$1.50");
    expect(formatUsd(0.0042, "en-US")).toBe("$0.0042");
  });
});
