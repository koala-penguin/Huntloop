import { lastUserText, registerFakeGenerator } from "../transport";

/** Demo-mode employer research: a search with a few results, then a report citing them. */
registerFakeGenerator("companyResearch", (req) => {
  const text = lastUserText(req.body);
  const name = /Employer: ([^\n(]+)/.exec(text)?.[1]?.trim() ?? "The company";
  const ko = /Output language: [^(]*\(ko\)/.test(text);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "company";
  const base = `https://www.example.com/${slug}`;
  const results = [
    { url: `${base}/about`, title: `${name} — About us`, page_age: "2026-09-01" },
    { url: `${base}/news/new-platform`, title: `${name} launches a new platform`, page_age: "2026-08-14" },
    { url: `${base}/careers`, title: `Careers at ${name}`, page_age: "2026-10-01" },
  ];
  const claim = (en: string, kr: string, url: string, date: string | null) => ({ text: ko ? kr : en, sourceUrl: url, date });
  const report = {
    summary: ko
      ? `${name}에 대한 데모 조사 결과입니다. API 키를 추가하면 Claude가 실제 웹 검색으로 조사합니다.`
      : `Demo research on ${name}. Add an API key and Claude researches the company on the live web.`,
    facts: { website: `${base}`, headquarters: null, founded: null, size: ko ? "약 500명 (데모)" : "About 500 people (demo)", ownership: "private", industry: null },
    sections: [
      {
        key: "business",
        confidence: "medium",
        claims: [claim(`${name} builds software for its industry (demo claim).`, `${name}는 업계용 소프트웨어를 만듭니다 (데모).`, results[0].url, "2026-09-01")],
      },
      {
        key: "activities",
        confidence: "medium",
        claims: [claim("Launched a new platform in August 2026 (demo claim).", "2026년 8월 새 플랫폼을 출시했습니다 (데모).", results[1].url, "2026-08-14")],
      },
      {
        key: "hiring",
        confidence: "low",
        claims: [
          claim("Is hiring across engineering and product (demo claim).", "엔지니어링과 제품 분야에서 채용 중입니다 (데모).", results[2].url, "2026-10-01"),
          claim("This claim cites a page that was never seen and is dropped.", "확인되지 않은 출처를 인용한 이 주장은 제외됩니다.", "https://unseen.example.org/rumour", null),
        ],
      },
    ],
    forYou: {
      talkingPoints: [ko ? "새 플랫폼 출시에 대한 관심을 이야기하세요." : "Mention their new platform launch and why it interests you."],
      cvAngles: [ko ? "플랫폼 구축 경험을 앞에 두세요." : "Lead with your platform-building experience."],
      questionsToAsk: [ko ? "새 플랫폼 팀은 어떻게 구성되어 있나요?" : "How is the team behind the new platform organised?"],
      referralAngles: [ko ? "같은 직무의 현직자에게 팀 문화를 물어보세요." : "Reach out to people in the same function about team culture."],
    },
  };
  return {
    webSearches: 1,
    content: [
      { type: "thinking", thinking: ko ? "회사 정보를 검색하는 중" : "Searching for the company", signature: "" },
      { type: "server_tool_use", id: "srvtoolu_demo_1", name: "web_search", input: { query: `${name} company` } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_demo_1", content: results.map((r) => ({ type: "web_search_result", encrypted_content: "demo", ...r })) },
      { type: "tool_use", id: "toolu_demo_report", name: "submit_company_report", input: report },
    ],
  };
});
