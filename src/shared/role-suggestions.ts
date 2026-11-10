import type { ChatOpening, ChatStage, CvBuilderTopic } from "./schemas/cv-builder";

/**
 * Example prompts for the CV-builder session, by kind of role: what people in that kind of job typically
 * own, achieve and use. They help the candidate start an answer; they are never evidence (only what
 * the candidate sends is). No digits anywhere, so a chip sent unedited can't put a figure on a CV.
 */

export type RoleFamily = "data_leadership" | "data" | "engineering" | "product" | "design" | "sales_marketing" | "operations" | "finance" | "people" | "generic";
type Lang = "en" | "ko";
type Topics = Partial<Record<CvBuilderTopic, string[]>>;

const FAMILY_RULES: Array<[RoleFamily, RegExp]> = [
  ["data_leadership", /head of (data|analytics|bi\b|insights)|chief data|\bcdo\b|(data|analytics|insights|bi) (director|lead|manager)|director of (data|analytics)|데이터.*(팀장|책임자|본부장|이사|리드)|(팀장|책임자|본부장|이사|리드).*데이터/i],
  ["data", /\bdata\b|analyst|analytics|\bbi\b|machine learning|\bml\b|statistic|데이터|분석/i],
  ["engineering", /engineer|developer|devops|\bsre\b|programmer|architect|개발|엔지니어/i],
  ["product", /product (manager|owner|lead)|\bpm\b|기획|프로덕트/i],
  ["design", /design|\bux\b|\bui\b|디자인/i],
  ["sales_marketing", /sales|account (manager|executive)|marketing|growth|business development|영업|마케팅/i],
  ["finance", /financ|account(ant|ing)|audit|controller|treasur|재무|회계/i],
  ["people", /\bhr\b|human resources|people|recruit|talent|인사|채용/i],
  ["operations", /operations|\bops\b|logistics|supply chain|project manager|program manager|운영|물류/i],
];

/** The kind of role a job title is, for picking example prompts. */
export function roleFamily(title: string | null | undefined): RoleFamily {
  const t = (title ?? "").trim();
  return FAMILY_RULES.find(([, re]) => re.test(t))?.[0] ?? "generic";
}

/** Single-word tool names used in the examples (a revision may never add one the candidate didn't type). */
export const TOOL_TERMS = ["snowflake", "bigquery", "redshift", "databricks", "dbt", "tableau", "looker", "python", "java", "sql", "airflow", "excel", "jira", "figma", "salesforce", "hubspot", "aws", "azure", "gcp", "kubernetes", "docker", "react", "typescript", "xero", "sap", "workday", "notion"];

const EN: Record<RoleFamily, Topics> = {
  data_leadership: {
    responsibility: ["Owning the data platform and its roadmap", "Data governance and quality", "Hiring and growing the analytics team", "Reporting company metrics to the exec team", "Managing the data budget and vendors"],
    achievement: ["Cut report turnaround time", "Replaced a legacy warehouse", "Grew the team", "Introduced self-serve dashboards", "Reduced data incidents"],
    tool: ["Snowflake / BigQuery / Redshift", "dbt", "Power BI / Tableau / Looker", "Python / SQL", "Airflow"],
  },
  data: {
    responsibility: ["Building and maintaining reports", "Cleaning and modelling data", "Answering questions from the business", "Running analyses and experiments", "Looking after data pipelines"],
    achievement: ["Automated a manual report", "Found a cost saving in the data", "Built a model the business used", "Made a dashboard people relied on", "Sped up a slow pipeline"],
    tool: ["SQL", "Python", "Power BI / Tableau / Looker", "Excel", "dbt / Airflow"],
  },
  engineering: {
    responsibility: ["Designing and building features", "Code reviews and mentoring", "Keeping systems running and on call", "Technical design and architecture", "Working with product on scope"],
    achievement: ["Shipped a major feature", "Made a page or service faster", "Cut errors or incidents", "Moved a system to the cloud", "Improved the release process"],
    tool: ["React / TypeScript", "Python / Java", "AWS / Azure / GCP", "Docker / Kubernetes", "CI and testing tools"],
  },
  product: {
    responsibility: ["Setting the roadmap", "Talking to customers", "Writing specs with the team", "Prioritising the backlog", "Launching and measuring features"],
    achievement: ["Launched a new product or feature", "Raised conversion or retention", "Cut churn", "Opened a new market", "Killed a feature that wasn't working"],
    tool: ["Jira", "Figma", "Analytics tools", "Customer research", "A/B testing"],
  },
  design: {
    responsibility: ["Designing user flows and screens", "User research and testing", "Running the design system", "Working with engineers on build", "Presenting designs to stakeholders"],
    achievement: ["Redesigned a key flow", "Raised task completion", "Built a design system", "Cut support tickets with a clearer UI", "Ran research that changed a decision"],
    tool: ["Figma", "Prototyping", "Usability testing", "Design systems", "Accessibility checks"],
  },
  sales_marketing: {
    responsibility: ["Owning a target or quota", "Managing key accounts", "Running campaigns", "Building the pipeline", "Working with product on pricing"],
    achievement: ["Beat a sales target", "Won a big account", "Grew leads or revenue", "Launched a campaign that worked", "Opened a new channel"],
    tool: ["Salesforce", "HubSpot", "Google Ads / Meta Ads", "Email tools", "Analytics tools"],
  },
  operations: {
    responsibility: ["Running day-to-day operations", "Managing suppliers", "Improving processes", "Planning and scheduling", "Health and safety"],
    achievement: ["Cut costs", "Sped up a process", "Reduced errors or delays", "Set up a new site or team", "Improved on-time delivery"],
    tool: ["Excel", "ERP systems", "Lean / Six Sigma", "Project tools", "Reporting dashboards"],
  },
  finance: {
    responsibility: ["Month-end close", "Budgets and forecasts", "Reporting to management", "Audit and compliance", "Payroll and accounts"],
    achievement: ["Shortened the close", "Found savings", "Passed an audit cleanly", "Built a better forecast", "Moved to a new finance system"],
    tool: ["Excel", "Xero", "SAP", "Power BI", "Financial modelling"],
  },
  people: {
    responsibility: ["Hiring and onboarding", "Employee relations", "Policies and compliance", "Learning and development", "Pay and benefits"],
    achievement: ["Filled hard roles faster", "Cut staff turnover", "Launched a training programme", "Improved engagement", "Rolled out a new HR system"],
    tool: ["Workday", "Applicant tracking systems", "Excel", "Survey tools", "Payroll systems"],
  },
  generic: {
    responsibility: ["Day-to-day running of the work", "Looking after customers or clients", "Training new people", "Keeping records and reports", "Working with other teams"],
    achievement: ["Something you improved", "A problem you solved", "Praise or an award you got", "Money or time you saved", "Something new you set up"],
    tool: ["Excel", "Industry software", "Equipment you used", "Methods you followed", "Languages you used at work"],
  },
};

const KO: Record<RoleFamily, Topics> = {
  data_leadership: {
    responsibility: ["데이터 플랫폼과 로드맵 담당", "데이터 거버넌스와 품질 관리", "분석 팀 채용과 육성", "경영진에 회사 지표 보고", "데이터 예산과 외부 업체 관리"],
    achievement: ["보고서 작성 시간 단축", "기존 데이터 웨어하우스 교체", "팀 확장", "셀프서비스 대시보드 도입", "데이터 장애 감소"],
    tool: ["Snowflake / BigQuery / Redshift", "dbt", "Power BI / Tableau / Looker", "Python / SQL", "Airflow"],
  },
  data: {
    responsibility: ["보고서 제작과 관리", "데이터 정제와 모델링", "현업 질문에 답하기", "분석과 실험", "데이터 파이프라인 관리"],
    achievement: ["수작업 보고서 자동화", "데이터로 비용 절감 발견", "현업이 쓰는 모델 구축", "자주 쓰이는 대시보드 제작", "느린 파이프라인 개선"],
    tool: ["SQL", "Python", "Power BI / Tableau / Looker", "Excel", "dbt / Airflow"],
  },
  engineering: {
    responsibility: ["기능 설계와 개발", "코드 리뷰와 멘토링", "시스템 운영과 온콜", "기술 설계와 아키텍처", "기획과 범위 조율"],
    achievement: ["주요 기능 출시", "페이지나 서비스 속도 개선", "오류나 장애 감소", "클라우드 이전", "배포 과정 개선"],
    tool: ["React / TypeScript", "Python / Java", "AWS / Azure / GCP", "Docker / Kubernetes", "CI와 테스트 도구"],
  },
  product: {
    responsibility: ["로드맵 수립", "고객 인터뷰", "팀과 기획서 작성", "백로그 우선순위", "출시와 성과 측정"],
    achievement: ["새 제품이나 기능 출시", "전환율이나 유지율 개선", "이탈 감소", "새 시장 진출", "효과 없는 기능 정리"],
    tool: ["Jira", "Figma", "분석 도구", "고객 조사", "A/B 테스트"],
  },
  design: {
    responsibility: ["사용자 흐름과 화면 설계", "사용자 조사와 테스트", "디자인 시스템 운영", "개발자와 구현 협업", "디자인 발표"],
    achievement: ["핵심 흐름 개편", "과업 완료율 개선", "디자인 시스템 구축", "더 쉬운 화면으로 문의 감소", "조사로 의사결정 변경"],
    tool: ["Figma", "프로토타이핑", "사용성 테스트", "디자인 시스템", "접근성 점검"],
  },
  sales_marketing: {
    responsibility: ["매출 목표 담당", "주요 고객 관리", "캠페인 운영", "영업 파이프라인 구축", "가격 정책 협업"],
    achievement: ["매출 목표 초과 달성", "대형 고객 수주", "리드나 매출 성장", "성과 좋은 캠페인", "새 채널 개척"],
    tool: ["Salesforce", "HubSpot", "검색·소셜 광고", "이메일 도구", "분석 도구"],
  },
  operations: {
    responsibility: ["일상 운영", "공급업체 관리", "프로세스 개선", "계획과 일정 관리", "안전 관리"],
    achievement: ["비용 절감", "처리 속도 개선", "오류나 지연 감소", "새 사업장이나 팀 구축", "정시 배송률 개선"],
    tool: ["Excel", "ERP 시스템", "린 / 식스시그마", "프로젝트 관리 도구", "보고 대시보드"],
  },
  finance: {
    responsibility: ["월말 결산", "예산과 예측", "경영 보고", "감사와 규정 준수", "급여와 회계"],
    achievement: ["결산 기간 단축", "비용 절감 발견", "감사 무사 통과", "더 나은 예측 모델", "새 재무 시스템 도입"],
    tool: ["Excel", "Xero", "SAP", "Power BI", "재무 모델링"],
  },
  people: {
    responsibility: ["채용과 온보딩", "노사 관계", "규정과 정책", "교육과 개발", "급여와 복리후생"],
    achievement: ["어려운 채용 기간 단축", "이직률 감소", "교육 프로그램 도입", "직원 만족도 개선", "새 인사 시스템 도입"],
    tool: ["Workday", "채용 관리 시스템", "Excel", "설문 도구", "급여 시스템"],
  },
  generic: {
    responsibility: ["업무의 일상 운영", "고객 응대", "신입 교육", "기록과 보고", "다른 팀과 협업"],
    achievement: ["개선한 일", "해결한 문제", "받은 칭찬이나 상", "아낀 비용이나 시간", "새로 만든 것"],
    tool: ["Excel", "업계 소프트웨어", "사용한 장비", "따른 방법론", "업무에 쓴 언어"],
  },
};

const COMMON: Record<Lang, Topics> = {
  en: {
    scope: ["Team size and who reported to you", "Budget or revenue you looked after", "Customers or users you served", "Systems or sites you covered", "Who you reported to"],
    context: ["Meetings and planning", "Hands-on work", "Managing people", "Working with customers", "Reporting and admin"],
    other: ["More hands-on work", "More leadership", "Less travel", "A bigger team", "A different industry"],
    extra: ["Volunteering", "Awards", "Side projects", "Talks or writing", "Committees or boards"],
  },
  ko: {
    scope: ["팀 규모와 보고 라인", "담당 예산이나 매출", "담당 고객이나 사용자", "담당 시스템이나 사업장", "보고 대상"],
    context: ["회의와 계획", "실무", "팀원 관리", "고객 응대", "보고와 행정"],
    other: ["더 많은 실무", "더 많은 리더십", "출장 감소", "더 큰 팀", "다른 업계"],
    extra: ["봉사 활동", "수상", "개인 프로젝트", "발표나 글", "위원회 활동"],
  },
};

/**
 * Job titles people in each kind of role often held before, offered when the interviewer asks about
 * earlier jobs. Like every example: a starting point for the candidate's own answer, never a fact.
 */
export const EARLIER_ROLES: Record<RoleFamily, Record<Lang, string[]>> = {
  data_leadership: { en: ["Analytics Manager", "Senior Data Analyst", "BI Lead"], ko: ["분석 매니저", "시니어 데이터 분석가", "BI 리드"] },
  data: { en: ["Junior Data Analyst", "Reporting Analyst", "Business Analyst"], ko: ["주니어 데이터 분석가", "리포팅 담당", "비즈니스 분석가"] },
  engineering: { en: ["Software Engineer", "Junior Developer", "Graduate Engineer"], ko: ["소프트웨어 엔지니어", "주니어 개발자", "신입 엔지니어"] },
  product: { en: ["Associate Product Manager", "Business Analyst", "Project Coordinator"], ko: ["주니어 PM", "비즈니스 분석가", "프로젝트 코디네이터"] },
  design: { en: ["Junior Designer", "Graphic Designer", "UX Researcher"], ko: ["주니어 디자이너", "그래픽 디자이너", "UX 리서처"] },
  sales_marketing: { en: ["Account Executive", "Sales Representative", "Marketing Coordinator"], ko: ["영업 담당", "영업 사원", "마케팅 코디네이터"] },
  operations: { en: ["Operations Coordinator", "Team Leader", "Supervisor"], ko: ["운영 코디네이터", "팀 리더", "현장 관리자"] },
  finance: { en: ["Assistant Accountant", "Accounts Officer", "Financial Analyst"], ko: ["회계 담당", "경리 담당", "재무 분석가"] },
  people: { en: ["HR Coordinator", "Recruiter", "HR Advisor"], ko: ["인사 코디네이터", "채용 담당", "인사 담당"] },
  generic: { en: [], ko: [] },
};

/** Example prompts for one topic and kind of role (3–6 short phrases). */
export function suggestionsFor(family: RoleFamily, topic: CvBuilderTopic, language: string): string[] {
  const lang: Lang = language === "ko" ? "ko" : "en";
  const own = (lang === "ko" ? KO : EN)[family][topic] ?? (lang === "ko" ? KO : EN).generic[topic];
  return own ?? COMMON[lang][topic] ?? COMMON[lang].extra!;
}

interface OpeningInput {
  stage: ChatStage;
  role: { title: string; company: string } | null;
  depth: "deep" | "brief" | null;
  targetTitles: string[];
  language: string;
  /** The current-situation chat: true when the candidate is between jobs (talk about the last one). */
  past?: boolean;
}

function roleName(role: OpeningInput["role"], ko: boolean): string {
  const title = role?.title.trim() || (ko ? "이 역할" : "this role");
  const company = role?.company.trim();
  return company ? (ko ? `${company}의 ${title}` : `${title} at ${company}`) : title;
}

/** The first question of a chat, built from the role, with examples for its topic. */
export function openingFor(input: OpeningInput): ChatOpening {
  const ko = input.language === "ko";
  const family = roleFamily(input.role?.title || input.targetTitles[0]);
  const name = roleName(input.role, ko);
  if (input.stage === "current") {
    const text = input.role?.title
      ? ko
        ? input.past
          ? `가장 최근에 하신 일: ${name}. 평소 한 주는 어땠나요?`
          : `지금 하시는 일: ${name}. 평소 한 주는 어떤가요?`
        : input.past
          ? `Your last job was ${name}. What did a normal week look like?`
          : `You're ${name} right now. What does a normal week look like?`
      : ko
        ? "지금 하고 있는 일(또는 가장 최근 일)의 평소 한 주를 들려주세요."
        : "Tell me about a normal week in your current (or most recent) job.";
    return { text, options: suggestionsFor(family, "context", input.language), topic: "context" };
  }
  if (input.depth === "brief") {
    return {
      text: ko ? `${name}: 짧게 볼게요. 주로 어떤 일을 하셨나요? 예시에서 골라 고쳐 써도 됩니다.` : `Let's keep ${name} short. What did you mostly do there? Pick an example below and edit it, or type your own.`,
      options: suggestionsFor(family, "responsibility", input.language),
      topic: "responsibility",
    };
  }
  return {
    text: ko
      ? `${name} 시절 이야기를 해 볼게요. 본인과 팀이 맡았던 일은 무엇이었나요? 예시에서 몇 개 골라 시작하거나 직접 적어 주세요.`
      : `Let's talk about your time as ${name}. What did you and your team own there? Pick a few of these to start, or type your own.`,
    options: suggestionsFor(family, "responsibility", input.language),
    topic: "responsibility",
  };
}
