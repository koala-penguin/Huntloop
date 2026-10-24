import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { canonicalizeUrl, domainPolicy, restrictedDomains } from "@/server/ingest/domain-policy";
import { FetchBlockedError, guardedLookup, isPrivateAddress, safeFetch, proxyConfigured } from "@/server/ingest/safe-fetch";
import { extractFromHtml, htmlToText } from "@/server/ingest/html";
import { detectAtsUrl, fetchAtsBoardSummary, fetchAtsPosting } from "@/server/sources/ats";
import { prepareScreenshot } from "@/server/ingest/images";

const fixture = (...parts: string[]) => readFileSync(path.join(__dirname, "..", "fixtures", ...parts), "utf8");

describe("domain policy", () => {
  it("routes each site to the right reading mode", () => {
    expect(domainPolicy(new URL("https://www.seek.com.au/job/81234567"))).toEqual({ mode: "browser", site: "seek" });
    expect(domainPolicy(new URL("https://au.linkedin.com/jobs/view/123"))).toEqual({ mode: "browser", site: "linkedin" });
    expect(domainPolicy(new URL("https://au.indeed.com/viewjob?jk=1"))).toEqual({ mode: "paste", site: "indeed" });
    expect(domainPolicy(new URL("https://job-boards.greenhouse.io/canva/jobs/1"))).toEqual({ mode: "api", site: "greenhouse" });
    expect(domainPolicy(new URL("https://careers.example.com/jobs/1"))).toEqual({ mode: "fetch", site: null });
  });

  it("canonicalizes tracking parameters and LinkedIn collection links", () => {
    expect(canonicalizeUrl("https://careers.example.com/jobs/1?utm_source=x&gh_src=1&ref=abc#apply")).toBe("https://careers.example.com/jobs/1?gh_src=1");
    expect(canonicalizeUrl("https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4011&trk=x")).toBe("https://www.linkedin.com/jobs/view/4011");
    expect(canonicalizeUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalizeUrl("not a url")).toBeNull();
  });

  it("keeps the restricted-domain list in step with the site rules", () => {
    const list = restrictedDomains();
    for (const d of list) expect(["browser", "paste"], d).toContain(domainPolicy(new URL(`https://www.${d}/x`)).mode);
    for (const d of ["jobsdb.com", "monster.com", "glassdoor.com.au", "indeed.com.au", "jobstreet.com.my", "ziprecruiter.co.uk", "seek.com.au", "linkedin.com"]) {
      expect(list, d).toContain(d);
    }
    expect(new Set(list).size).toBe(list.length);
  });
});

describe("safe fetch", () => {
  it("recognises private and special addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["1.1.1.1", "142.250.70.78", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("sees through IPv6 forms that carry an IPv4 address", () => {
    const priv = ["::ffff:7f00:1", "::ffff:a00:1", "::7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "::ffff:0:7f00:1", "64:ff9b:1::a00:1", "::ffff:a9fe:a9fe", "fe80::1%en0", "::", "ff02::1"];
    for (const ip of priv) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["2001:4860:4860::8888", "::ffff:808:808", "2002:808:808::", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses an IPv4-mapped loopback written as an IPv6 literal", async () => {
    await expect(safeFetch("http://[::ffff:127.0.0.1]/", { fetchImpl: okFetch("x") })).rejects.toMatchObject({ reason: "private_address" });
  });

  it("checks the address again when the connection is made", async () => {
    type Fake = (host: string, options: object, cb: (...args: unknown[]) => void) => void;
    const call = (fake: Fake, options: object) =>
      new Promise<unknown[]>((resolve) => guardedLookup(fake as never)("jobs.example", options as never, ((...args: unknown[]) => resolve(args)) as never));
    const all = (address: string): Fake => (_h, _o, cb) => cb(null, [{ address, family: 4 }]);

    const [blocked] = await call(all("10.0.0.5"), { all: true });
    expect(blocked).toBeInstanceOf(FetchBlockedError);
    expect(blocked).toMatchObject({ reason: "private_address" });

    const passed = await call(all("93.184.216.34"), { all: true });
    expect(passed).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);

    const [single] = await call(all("10.0.0.5"), {});
    expect(single).toMatchObject({ reason: "private_address" });
    const singleOk = await call(all("93.184.216.34"), {});
    expect(singleOk).toEqual([null, "93.184.216.34", 4]);
  });

  it("reports a refused connection as a private address", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed", { cause: new FetchBlockedError("private_address") });
    }) as unknown as typeof fetch;
    await expect(safeFetch("https://jobs.example/", { fetchImpl: failing, resolve: async () => ["93.184.216.34"] })).rejects.toMatchObject({ reason: "private_address" });
  });

  const okFetch = (body: string, init: ResponseInit = {}) => (async () => new Response(body, { status: 200, ...init })) as unknown as typeof fetch;

  it("blocks hosts that resolve to private addresses", async () => {
    await expect(safeFetch("http://localhost:3000/", { fetchImpl: okFetch("x") })).rejects.toMatchObject({ reason: "private_address" });
    await expect(safeFetch("http://169.254.169.254/latest", { fetchImpl: okFetch("x") })).rejects.toMatchObject({ reason: "private_address" });
    await expect(safeFetch("https://evil.example/", { fetchImpl: okFetch("x"), resolve: async () => ["10.0.0.5"] })).rejects.toBeInstanceOf(FetchBlockedError);
    await expect(safeFetch("file:///etc/passwd", { fetchImpl: okFetch("x") })).rejects.toMatchObject({ reason: "invalid_url" });
  });

  it("re-checks every redirect hop and caps redirects", async () => {
    const redirectTo = (location: string) => (async () => new Response(null, { status: 302, headers: { location } })) as unknown as typeof fetch;
    const resolve = async (host: string) => (host === "internal.example" ? ["192.168.0.10"] : ["93.184.216.34"]);
    await expect(safeFetch("https://jobs.example/", { fetchImpl: redirectTo("https://internal.example/admin"), resolve })).rejects.toMatchObject({ reason: "private_address" });
    await expect(safeFetch("https://jobs.example/", { fetchImpl: redirectTo("https://jobs.example/next"), resolve })).rejects.toMatchObject({ reason: "too_many_redirects" });
  });

  it("applies the site rule to every redirect target", async () => {
    const resolve = async () => ["93.184.216.34"];
    const redirect = (async () => new Response(null, { status: 302, headers: { location: "https://www.seek.com.au/job/1" } })) as unknown as typeof fetch;
    const allow = (u: URL) => domainPolicy(u).mode === "fetch";
    await expect(safeFetch("https://jobs.example/land/1", { fetchImpl: redirect, resolve, allow })).rejects.toMatchObject({ reason: "restricted", url: "https://www.seek.com.au/job/1" });
  });

  it("enforces the size cap and reports HTTP errors", async () => {
    const resolve = async () => ["93.184.216.34"];
    await expect(safeFetch("https://jobs.example/", { fetchImpl: okFetch("x".repeat(5000)), resolve, maxBytes: 1000 })).rejects.toMatchObject({ reason: "too_large" });
    await expect(safeFetch("https://jobs.example/", { fetchImpl: okFetch("gone", { status: 404 }), resolve })).rejects.toMatchObject({ reason: "http_error", status: 404 });
    const ok = await safeFetch("https://jobs.example/", { fetchImpl: okFetch("<p>hello</p>", { headers: { "content-type": "text/html" } }), resolve });
    expect(ok).toMatchObject({ status: 200, body: "<p>hello</p>", contentType: "text/html" });
  });
});

describe("safe fetch behind a proxy", () => {
  const okFetch = (body: string) => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
  const notFound = async () => {
    throw Object.assign(new Error("getaddrinfo ENOTFOUND jobs.example"), { code: "ENOTFOUND" });
  };

  it("lets the proxy resolve names this machine can't, but still refuses local addresses", async () => {
    const ok = await safeFetch("https://jobs.example/", { fetchImpl: okFetch("<p>open</p>"), resolve: notFound, viaProxy: true });
    expect(ok.body).toBe("<p>open</p>");
    await expect(safeFetch("https://jobs.example/", { fetchImpl: okFetch("x"), resolve: notFound, viaProxy: false })).rejects.toMatchObject({ code: "ENOTFOUND" });
    await expect(safeFetch("http://10.0.0.5/", { fetchImpl: okFetch("x"), viaProxy: true })).rejects.toMatchObject({ reason: "private_address" });
    await expect(safeFetch("http://metadata.internal/", { fetchImpl: okFetch("x"), viaProxy: true })).rejects.toMatchObject({ reason: "private_address" });
    // A name that does resolve is still checked.
    await expect(safeFetch("https://jobs.example/", { fetchImpl: okFetch("x"), resolve: async () => ["192.168.1.2"], viaProxy: true })).rejects.toMatchObject({ reason: "private_address" });
  });

  it("knows when a proxy is configured", () => {
    expect(proxyConfigured({ HTTPS_PROXY: "http://proxy:8080" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(proxyConfigured({ http_proxy: "http://proxy:8080" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(proxyConfigured({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("HTML extraction", () => {
  it("turns HTML into readable text with bullets, including entity-escaped HTML", () => {
    expect(htmlToText("<p>Hello</p><ul><li>One</li><li>Two</li></ul>")).toBe("Hello\n• One\n• Two");
    expect(htmlToText("&lt;p&gt;Hi &amp;amp; bye&lt;/p&gt;")).toBe("Hi & bye");
  });

  it("reads a JobPosting from a JSON-LD @graph", () => {
    const page = extractFromHtml(fixture("html", "jsonld-graph.html"));
    expect(page.structured).toBe(true);
    expect(page.text).toContain("• Australian citizenship or permanent residency");
    expect(page.hints).toMatchObject({ title: "Senior Data Analyst", company: "Example Health", city: "Melbourne", country: "AU", postedAt: "2026-10-03" });
    expect(page.hints.salaryText).toBe("AUD 120000 – 135000 YEAR");
  });

  it("reads Next.js page data", () => {
    const page = extractFromHtml(fixture("html", "next-data.html"));
    expect(page.text).toContain("right to work in New Zealand");
    expect(page.challenge || page.shell).toBe(false);
  });

  it("detects bot challenges and empty app shells", () => {
    expect(extractFromHtml(fixture("html", "challenge.html"))).toMatchObject({ challenge: true });
    expect(extractFromHtml(fixture("html", "shell.html"))).toMatchObject({ challenge: false, shell: true });
  });
});

describe("ATS adapters", () => {
  it("detects Greenhouse, Lever and Ashby job URLs", () => {
    expect(detectAtsUrl(new URL("https://job-boards.greenhouse.io/canva/jobs/4012345"))).toMatchObject({ type: "greenhouse", board: "canva", id: "4012345" });
    expect(detectAtsUrl(new URL("https://boards.greenhouse.io/embed/job_app?for=x"))).toBeNull();
    expect(detectAtsUrl(new URL("https://jobs.eu.lever.co/xero/6f1c2a7e-4b2d-4f1e-9a8b-1c2d3e4f5a6b/apply"))).toMatchObject({ type: "lever", board: "xero", eu: true });
    expect(detectAtsUrl(new URL("https://jobs.ashbyhq.com/grab-like/0b9a8c7d-1e2f-4a3b-8c9d-0e1f2a3b4c5d"))).toMatchObject({ type: "ashby", board: "grab-like" });
    expect(detectAtsUrl(new URL("https://careers.example.com/jobs/1"))).toBeNull();
  });

  const fixtureFetcher = (file: string) => {
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      return JSON.parse(fixture("api", file));
    };
    return { calls, fetcher };
  };

  it("normalizes a Greenhouse posting (escaped HTML content, pay range)", async () => {
    const { calls, fetcher } = fixtureFetcher("greenhouse-job.json");
    const posting = await fetchAtsPosting(detectAtsUrl(new URL("https://job-boards.greenhouse.io/canva/jobs/4012345"))!, fetcher);
    expect(calls[0]).toBe("https://boards-api.greenhouse.io/v1/boards/canva/jobs/4012345?pay_transparency=true");
    expect(posting.text).toContain("• 5+ years building web applications with React and TypeScript");
    expect(posting.text).toContain("full working rights in Australia");
    expect(posting.hints).toMatchObject({ title: "Senior Frontend Engineer", company: "Canva", locationText: "Sydney, Australia", salaryText: "AUD 180000–220000 Base + super" });
  });

  it("normalizes a Lever posting with lists and workplace type", async () => {
    const { calls, fetcher } = fixtureFetcher("lever-job.json");
    const posting = await fetchAtsPosting(detectAtsUrl(new URL("https://jobs.lever.co/xero/6f1c2a7e-4b2d-4f1e-9a8b-1c2d3e4f5a6b"))!, fetcher);
    expect(calls[0]).toBe("https://api.lever.co/v0/postings/xero/6f1c2a7e-4b2d-4f1e-9a8b-1c2d3e4f5a6b?mode=json");
    expect(posting.text).toContain("What you'll need\n• 3+ years with Go");
    expect(posting.hints).toMatchObject({ country: "NZ", workplace: "hybrid", employmentType: "Full-time", company: "Xero" });
  });

  it("finds an Ashby job on its board and summarises open roles", async () => {
    const { fetcher } = fixtureFetcher("ashby-board.json");
    const posting = await fetchAtsPosting(detectAtsUrl(new URL("https://jobs.ashbyhq.com/grab-like/0b9a8c7d-1e2f-4a3b-8c9d-0e1f2a3b4c5d"))!, fetcher);
    expect(posting.hints).toMatchObject({ title: "Data Engineer", country: "SG", workplace: "hybrid", salaryText: "SGD 8K – 11K per month" });
    const summary = await fetchAtsBoardSummary("ashby", "grab-like", fetcher);
    expect(summary.total).toBe(2);
    expect(summary.byDepartment).toEqual([
      { name: "Data", count: 1 },
      { name: "People", count: 1 },
    ]);
  });
});

describe("screenshot preparation", () => {
  it("keeps a normal screenshot as one image within the size limit", async () => {
    const png = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const images = await prepareScreenshot(png);
    expect(images).toHaveLength(1);
    expect(Math.max(images[0].width, images[0].height)).toBeLessThanOrEqual(1568);
  });

  it("splits a tall full-page capture into overlapping tiles", async () => {
    const png = await sharp({ create: { width: 1200, height: 6000, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const images = await prepareScreenshot(png);
    expect(images.length).toBeGreaterThanOrEqual(3);
    for (const img of images) expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(1568);
  });
});
