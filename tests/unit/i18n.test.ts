import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import ko from "../../messages/ko.json";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

/** ICU argument names used in a message, e.g. "{count, plural, ...}" → "count". */
function args(message: string): string[] {
  return [...message.matchAll(/\{\s*([a-zA-Z0-9_]+)\s*(?:[,}])/g)].map((m) => m[1]).sort();
}

describe("message catalogs", () => {
  const enMap = flatten(en as Tree);
  const koMap = flatten(ko as Tree);

  it("have exactly the same keys in English and Korean", () => {
    const missingInKo = [...enMap.keys()].filter((k) => !koMap.has(k));
    const missingInEn = [...koMap.keys()].filter((k) => !enMap.has(k));
    expect({ missingInKo, missingInEn }).toEqual({ missingInKo: [], missingInEn: [] });
  });

  it("have no empty messages", () => {
    const empty = [...enMap, ...koMap].filter(([, v]) => v.trim() === "").map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it("use the same placeholders in both languages", () => {
    const mismatched = [...enMap.keys()]
      .filter((k) => koMap.has(k))
      .filter((k) => JSON.stringify([...new Set(args(enMap.get(k)!))]) !== JSON.stringify([...new Set(args(koMap.get(k)!))]));
    expect(mismatched).toEqual([]);
  });
});
