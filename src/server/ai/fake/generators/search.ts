import { lastUserText, registerFakeGenerator } from "../transport";
import { KNOWN_SKILLS, mentions } from "./extract-profile";

/** Demo-mode search planning and web-search agent. */

const CITY_WORDS: Array<[RegExp, string, string]> = [
  [/sydney|시드니/i, "Sydney", "AU"], [/melbourne|멜버른|멜번/i, "Melbourne", "AU"], [/brisbane|브리즈번/i, "Brisbane", "AU"], [/perth|퍼스/i, "Perth", "AU"],
  [/adelaide|애들레이드/i, "Adelaide", "AU"], [/canberra|캔버라/i, "Canberra", "AU"], [/auckland|오클랜드/i, "Auckland", "NZ"], [/wellington|웰링턴/i, "Wellington", "NZ"],
  [/singapore|싱가포르/i, "Singapore", "SG"], [/new york|뉴욕/i, "New York", "US"], [/san francisco|샌프란시스코/i, "San Francisco", "US"], [/seattle|시애틀/i, "Seattle", "US"],
];
const TITLE_WORDS: Array<[RegExp, string]> = [
  [/front[- ]?end|프론트엔드|프런트엔드/i, "Frontend Engineer"], [/back[- ]?end|백엔드/i, "Backend Engineer"], [/full[- ]?stack|풀스택/i, "Full Stack Engineer"],
  [/data engineer|데이터 엔지니어/i, "Data Engineer"], [/data scien|데이터 사이언/i, "Data Scientist"], [/data analyst|데이터 분석/i, "Data Analyst"],
  [/product manager|프로덕트 매니저|PM\b/i, "Product Manager"], [/product designer|ux|ui designer|디자이너/i, "Product Designer"],
  [/devops|sre|platform engineer|데브옵스/i, "Platform Engineer"], [/mobile|ios|android|모바일/i, "Mobile Engineer"], [/software engineer|소프트웨어|개발자/i, "Software Engineer"],
];

function between(text: string, tag: string): string | null {
  return new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1] ?? null;
}

registerFakeGenerator("parseSearch", (req) => {
  const text = lastUserText(req.body);
  const request = between(text, "request") ?? "";
  const saved = JSON.parse(between(text, "saved_preferences") ?? "{}") as { filters?: Record<string, unknown> };
  const defaults = (saved.filters ?? {}) as Record<string, unknown>;
  const cities = CITY_WORDS.filter(([re]) => re.test(request)).map(([, city, country]) => ({ country, city }));
  const titles = TITLE_WORDS.filter(([re]) => re.test(request)).map(([, title]) => title);
  const seniority = /\bsenior\b|시니어/i.test(request) ? ["senior"] : /\bjunior\b|주니어|graduate|신입/i.test(request) ? ["junior"] : /\blead\b|리드/i.test(request) ? ["lead"] : defaults.seniority;
  const workplace = /remote|원격|재택/i.test(request) ? ["remote"] : /hybrid|하이브리드/i.test(request) ? ["hybrid", "onsite"] : defaults.workplace;
  const salary = /(\d{2,3})\s?k\b/i.exec(request);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          titles: titles.length ? titles : (defaults.titles ?? []),
          keywords: KNOWN_SKILLS.filter(([name]) => mentions(request, name)).map(([name]) => name),
          locations: cities.length ? cities : (defaults.locations ?? []),
          workplace,
          employmentTypes: /contract|계약/i.test(request) ? ["contract"] : (defaults.employmentTypes ?? ["full_time"]),
          seniority: seniority ?? [],
          salaryMin: salary ? Number(salary[1]) * 1000 : (defaults.salaryMin ?? null),
          postedWithinDays: /today|오늘/i.test(request) ? 1 : /this week|이번 ?주/i.test(request) ? 7 : (defaults.postedWithinDays ?? null),
          excludeKeywords: [],
        }),
      },
    ],
  };
});

registerFakeGenerator("searchAgent", (req) => {
  const text = lastUserText(req.body);
  const filters = JSON.parse(between(text, "filters") ?? "{}") as { titles?: string[]; locations?: Array<{ country: string; city: string | null }> };
  const title = filters.titles?.[0] ?? "Software Engineer";
  const place = filters.locations?.[0];
  const city = place?.city ?? (place?.country === "NZ" ? "Auckland" : place?.country === "SG" ? "Singapore" : "Sydney");
  const country = place?.country ?? "AU";
  const results = [
    {
      url: "https://job-boards.greenhouse.io/demo-tidewater/jobs/7001001",
      title: `${title} — Tidewater Labs`,
      lead: { company: "Tidewater Labs", snippet: `Tidewater Labs is hiring a ${title} in ${city}. You will build customer-facing products with React and TypeScript. 4+ years of experience required.` },
    },
    {
      url: "https://jobs.lever.co/demo-quokka/0f0e0d0c-0b0a-4908-8706-050403020100",
      title: `${title} (Hybrid) — Quokka Cloud`,
      lead: { company: "Quokka Cloud", snippet: `Quokka Cloud is looking for a ${title} to join our platform team in ${city}. Experience with AWS and Kubernetes is a plus.` },
    },
    { url: "https://www.seek.com.au/job/99999999", title: `${title} job in ${city} - SEEK`, lead: null },
  ];
  const leads = [
    ...results.map((r) => ({
      url: r.url,
      title,
      company: r.lead?.company ?? null,
      location: city,
      country,
      snippet: r.lead?.snippet ?? `${title} in ${city}.`,
      postedText: "Posted 2 days ago",
    })),
    { url: "https://careers.unseen-demo.example/jobs/1", title, company: "Unseen Co", location: city, country, snippet: "Never appeared in the search results.", postedText: null },
  ];
  return {
    webSearches: 1,
    content: [
      { type: "thinking", thinking: `Searching for ${title} roles in ${city}`, signature: "" },
      { type: "server_tool_use", id: "srvtoolu_demo_search", name: "web_search", input: { query: `${title} ${city} careers` } },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_demo_search",
        content: results.map((r) => ({ type: "web_search_result", url: r.url, title: r.title, encrypted_content: "demo", page_age: "2 days ago" })),
      },
      { type: "tool_use", id: "toolu_demo_leads", name: "report_job_leads", input: { leads } },
    ],
  };
});
