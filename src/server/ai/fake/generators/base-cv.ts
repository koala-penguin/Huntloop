import { registerFakeGenerator } from "../transport";
import { between, json } from "./jobs";
import { context, DEMO_UNSUPPORTED_BULLET, roleLine } from "./tailoring";

/**
 * Demo-mode base CV (from the CV builder interview). Bullets are the candidate's own interview
 * answers, plus — like the tailored-CV demo — one deliberately unsupported bullet on the first role,
 * so the flag cards and the locked download are visible without an API key.
 */

const cvRef = (quote: string) => ({ source: "cv" as const, quote, factId: null });

registerFakeGenerator("buildBaseCv", (req) => {
  const { text, profile, language } = context(req);
  const target = (() => {
    try {
      return JSON.parse(between(text, "target") ?? "{}") as { titles?: string[]; roles?: Array<{ id: string; depth: string }> };
    } catch {
      return {};
    }
  })();
  const depth = new Map((target.roles ?? []).map((r) => [r.id, r.depth]));
  const ko = language === "ko";
  const lead = profile.experience[0];

  const roles = profile.experience.map((role, i) => {
    const bullets = role.highlights.slice(0, depth.get(role.id) === "brief" ? 2 : 6).map((h) => ({ text: h, sourceRefs: [cvRef(h)], requirementIds: [] }));
    if (i === 0 && role.highlights[0]) bullets.push({ text: DEMO_UNSUPPORTED_BULLET[language], sourceRefs: [cvRef(role.highlights[0])], requirementIds: [] });
    return { experienceId: role.id, bullets };
  });
  const titles = (target.titles ?? []).filter(Boolean);
  const summary = lead
    ? [
        {
          text: ko
            ? `${lead.company}의 ${lead.title}${titles.length ? `, ${titles.join(" 또는 ")} 역할을 찾고 있습니다.` : "."}`
            : `${lead.title} at ${lead.company}${titles.length ? `, looking for ${titles.join(" or ")} roles.` : "."}`,
          sourceRefs: [cvRef(roleLine(profile, lead))],
          requirementIds: [],
        },
      ]
    : [];
  return json({ summary, skills: profile.skills, roles });
});
