// Local stand-ins for SEEK and LinkedIn pages, for testing the browser adapters offline.
// Shapes follow the real sites closely enough for link harvesting, pagination, structured data,
// CAPTCHA pages and sign-in walls. Run directly: `node tests/fixtures/browser/sites.mjs <port>`.
import http from "node:http";

const page = (title, body, head = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

const jsonLd = (posting) => `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting", ...posting })}</script>`;

const SEEK_JOBS = {
  "81000001": () =>
    page(
      "Senior Frontend Engineer Job in Sydney NSW - SEEK",
      `<main><h1 data-automation="job-detail-title">Senior Frontend Engineer</h1><p>Posted 2d ago</p></main>`,
      jsonLd({
        title: "Senior Frontend Engineer",
        datePosted: "2026-10-11",
        employmentType: "FULL_TIME",
        hiringOrganization: { "@type": "Organization", name: "Harbour Lights Health" },
        jobLocation: { "@type": "Place", address: { addressLocality: "Sydney", addressRegion: "NSW", addressCountry: "AU" } },
        description:
          "<p>Harbour Lights Health is rebuilding its patient portal and needs a senior frontend engineer to lead the web team in Sydney.</p><ul><li>5+ years of professional frontend development</li><li>Strong React and TypeScript skills</li><li>Experience with accessibility (WCAG 2.2)</li><li>Healthcare experience is a plus</li></ul><p>You must have full working rights in Australia.</p>",
      }),
    ),
  "81000002": () =>
    page(
      "Frontend Developer Job in Sydney NSW - SEEK",
      `<main>
        <h1 data-automation="job-detail-title">Frontend Developer</h1>
        <span data-automation="advertiser-name">Koala Retail</span>
        <span data-automation="job-detail-location">Sydney NSW</span>
        <span data-automation="job-detail-salary">$130,000 – $145,000 + super</span>
        <div data-automation="jobAdDetails">
          <p>Koala Retail is looking for a frontend developer to build our online store with React and Next.js.</p>
          <ul><li>3+ years building web applications</li><li>React and TypeScript</li><li>Experience with e-commerce platforms is desirable</li></ul>
          <p>Hybrid: three days a week in our Surry Hills office.</p>
        </div>
      </main>`,
    ),
  "81000003": () =>
    page(
      "Frontend Engineer Job in Sydney NSW - SEEK",
      `<main>
        <h1 data-automation="job-detail-title">Frontend Engineer</h1>
        <span data-automation="advertiser-name">Wattle Fintech</span>
        <span data-automation="job-detail-location">Sydney NSW</span>
        <div data-automation="jobAdDetails"><p>Wattle Fintech is hiring a frontend engineer for its payments dashboard. You will work with React, TypeScript and GraphQL in a small product team.</p><ul><li>4+ years of frontend experience</li><li>Experience with GraphQL</li></ul></div>
      </main>`,
    ),
};

const LINKEDIN_JOBS = {
  "3900000001": () =>
    page(
      "Tidal Labs hiring Frontend Engineer in Sydney, New South Wales, Australia | LinkedIn",
      `<main><h1 class="top-card-layout__title">Frontend Engineer</h1><a class="topcard__org-name-link">Tidal Labs</a><span class="topcard__flavor--bullet">Sydney, New South Wales, Australia</span>
       <div class="show-more-less-html__markup"><p>Tidal Labs builds tools for ocean researchers.</p></div></main>`,
      jsonLd({
        title: "Frontend Engineer",
        datePosted: "2026-10-09",
        hiringOrganization: { "@type": "Organization", name: "Tidal Labs" },
        jobLocation: { "@type": "Place", address: { addressLocality: "Sydney", addressRegion: "New South Wales", addressCountry: "AU" } },
        description:
          "<p>Tidal Labs builds data tools for ocean researchers. We are hiring a frontend engineer to own our visualisation app.</p><ul><li>3+ years with React</li><li>Experience with data visualisation (D3 or similar)</li><li>TypeScript</li></ul>",
      }),
    ),
  "3900000002": () =>
    page(
      "Frontend Engineer | LinkedIn",
      `<main><h1 class="top-card-layout__title">Frontend Engineer</h1><a class="topcard__org-name-link">Reef Analytics</a><span class="topcard__flavor--bullet">Brisbane, Queensland, Australia</span>
       <div class="show-more-less-html__markup"><p>Reef Analytics is looking for a frontend engineer to build dashboards for environmental data. You will work closely with our data scientists using React and TypeScript.</p><ul><li>2+ years of frontend experience</li><li>Hybrid in Brisbane</li></ul></div></main>`,
    ),
};

const GREENHOUSE_JOBS = {
  701: {
    id: 701,
    title: "Senior Frontend Engineer",
    absolute_url: "https://acme.example/careers?gh_jid=701",
    location: { name: "Sydney, Australia" },
    updated_at: new Date().toISOString(),
    content:
      "&lt;p&gt;Acme Robotics builds warehouse robots. We are hiring a senior frontend engineer for our fleet dashboard in Sydney.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;5+ years of frontend development&lt;/li&gt;&lt;li&gt;React and TypeScript&lt;/li&gt;&lt;li&gt;Experience with data visualisation&lt;/li&gt;&lt;/ul&gt;&lt;p&gt;You must have full working rights in Australia.&lt;/p&gt;",
  },
  702: { id: 702, title: "Frontend Engineer", absolute_url: "https://acme.example/careers?gh_jid=702", location: { name: "Austin, TX" }, updated_at: new Date().toISOString(), content: "" },
  703: { id: 703, title: "Mechanical Engineer", absolute_url: "https://acme.example/careers?gh_jid=703", location: { name: "Sydney, Australia" }, updated_at: new Date().toISOString(), content: "" },
};

export function createState() {
  return { requests: [], captcha: false, solved: false, authwall: false, signedIn: false };
}

export function handler(state) {
  return (req, res) => {
    const url = new URL(req.url, "http://localhost");
    state.requests.push(url.pathname + url.search);
    const send = (status, html, headers = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(html);
    };
    // Test controls.
    if (url.pathname === "/__captcha") return (state.captcha = url.searchParams.get("on") === "1"), (state.solved = false), send(200, "ok");
    if (url.pathname === "/__solve") return (state.solved = true), send(200, "ok");
    if (url.pathname === "/__authwall") return (state.authwall = url.searchParams.get("on") === "1"), send(200, "ok");
    if (url.pathname === "/__signin") return (state.signedIn = true), send(200, "ok");
    if (url.pathname === "/__reset") return Object.assign(state, createState()), send(200, "ok");

    // SEEK-shaped pages.
    if (url.pathname === "/jobs") {
      const n = Number(url.searchParams.get("page") ?? "1");
      const links =
        n === 1
          ? `<a href="/job/81000001?type=standout">Senior Frontend Engineer</a><a href="/job/81000002">Frontend Developer</a><a href="/job/81000001?type=promoted">Senior Frontend Engineer</a><a href="/companies/koala-retail">Koala Retail</a><a href="https://other.example/job/9">Elsewhere</a>`
          : n === 2
            ? `<a href="/job/81000003">Frontend Engineer</a>`
            : `<p>No matching search results</p>`;
      return send(200, page("Jobs - SEEK", `<main>${links}<a href="/jobs?page=${n + 1}">Next</a></main>`));
    }
    const seek = /^\/job\/(\d+)$/.exec(url.pathname);
    if (seek && SEEK_JOBS[seek[1]]) {
      if (seek[1] === "81000003" && state.captcha && !state.solved) {
        return send(200, page("Just a moment...", `<div id="cf-chl-widget">Checking your browser before accessing the site.</div>`));
      }
      return send(200, SEEK_JOBS[seek[1]]());
    }

    // LinkedIn-shaped pages.
    if (url.pathname === "/jobs/search") {
      const start = Number(url.searchParams.get("start") ?? "0");
      const links =
        start === 0
          ? `<a href="/jobs/view/frontend-engineer-at-tidal-labs-3900000001?refId=abc&trk=public_jobs">Frontend Engineer</a><a href="/jobs/view/3900000002/">Frontend Engineer</a><a href="/company/tidal-labs">Tidal Labs</a>`
          : `<p>No more jobs</p>`;
      return send(200, page("Jobs | LinkedIn", `<main>${links}</main>`));
    }
    const li = /^\/jobs\/view\/(\d+)$/.exec(url.pathname);
    if (li && LINKEDIN_JOBS[li[1]]) {
      if (li[1] === "3900000002" && state.authwall && !state.signedIn) return send(302, "", { location: "/authwall?trk=job" });
      return send(200, LINKEDIN_JOBS[li[1]]());
    }
    if (url.pathname === "/authwall" || url.pathname === "/login") {
      return send(200, page("Sign In | LinkedIn", `<main><h1>Sign in to view more jobs</h1><form><input name="session_key"></form></main>`));
    }
    if (url.pathname === "/feed/") return state.signedIn ? send(200, page("Feed | LinkedIn", "<main>Welcome back</main>")) : send(302, "", { location: "/login?redirect=feed" });

    // A job board without an adapter (for the browsing agent).
    if (url.pathname === "/board/search") {
      return send(
        200,
        page(
          "Search jobs - Example Public Jobs",
          `<main><form role="search"><input type="search" aria-label="Search jobs" name="q"></form>
           <a href="/board/job/501">Frontend Engineer — Department of Example</a>
           <a href="/board/job/502">Senior Web Developer — Example Agency</a>
           <a href="/board/search?q=x&page=2">Next page</a>
           <button>Sign in</button></main>`,
        ),
      );
    }
    const board = /^\/board\/job\/(\d+)$/.exec(url.pathname);
    if (board) {
      const [title, org] = board[1] === "501" ? ["Frontend Engineer", "Department of Example"] : ["Senior Web Developer", "Example Agency"];
      return send(
        200,
        page(
          `${title} - Example Public Jobs`,
          `<main><h1>${title}</h1><p>${org} · Canberra ACT</p>
           <p>${org} is looking for a ${title.toLowerCase()} to build accessible online services used by millions of Australians.</p>
           <ul><li>4+ years building web applications</li><li>React and TypeScript</li><li>Australian citizenship is required</li></ul>
           <button>Apply now</button></main>`,
        ),
      );
    }

    // An employer's own website with a careers section.
    if (url.pathname === "/employer/") return send(200, page("Tidal Labs", `<main><h1>Tidal Labs</h1><a href="/employer/careers">Careers</a><a href="/employer/about">About us</a></main>`));
    if (url.pathname === "/employer/careers") {
      return send(
        200,
        page("Careers - Tidal Labs", `<main><h1>Open roles</h1><a href="/employer/careers/frontend-engineer">Frontend Engineer</a><a href="/employer/careers/data-scientist">Data Scientist</a></main>`),
      );
    }
    if (url.pathname === "/employer/careers/frontend-engineer") {
      return send(
        200,
        page(
          "Frontend Engineer - Tidal Labs Careers",
          `<main><h1>Frontend Engineer</h1><p>Tidal Labs · Sydney, Australia · Full time</p>
           <p>Tidal Labs builds data tools for ocean researchers. We are hiring a frontend engineer to own our visualisation app, working with scientists and our platform team.</p>
           <h2>What you'll bring</h2><ul><li>3+ years with React</li><li>Experience with data visualisation (D3 or similar)</li><li>TypeScript</li><li>Experience with WebGL is a plus</li></ul>
           <p>Salary: $150,000 – $170,000 + super. Hybrid, two days a week in our Sydney office.</p>
           <button>Apply for this job</button></main>`,
        ),
      );
    }

    // A Greenhouse-style job board API (HUNTLOOP_ATS_API_BASE=<url>/ats), for the employer watchlist.
    const json = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/ats/greenhouse/v1/boards/acme/jobs") return json({ jobs: Object.values(GREENHOUSE_JOBS).map((job) => ({ ...job, content: undefined })) });
    const gh = /^\/ats\/greenhouse\/v1\/boards\/acme\/jobs\/(\d+)$/.exec(url.pathname);
    if (gh && GREENHOUSE_JOBS[gh[1]]) return json({ ...GREENHOUSE_JOBS[gh[1]], company_name: "Acme Robotics" });

    send(404, page("Not found", "<p>Not found</p>"));
  };
}

/** Starts the fixture server; resolves with its base URL. */
export function startFixtureSites(port = 0) {
  const state = createState();
  const server = http.createServer(handler(state));
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => {
      const { port: actual } = server.address();
      resolve({ url: `http://127.0.0.1:${actual}`, state, close: () => new Promise((r) => server.close(r)) });
    }),
  );
}

if (process.argv[1] && process.argv[1].endsWith("sites.mjs")) {
  const port = Number(process.argv[2] ?? 3299);
  startFixtureSites(port).then(({ url }) => console.log(`fixture sites on ${url}`));
}
