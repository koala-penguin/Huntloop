import type { ReactNode } from "react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { conversations } from "@/server/db/schema";
import { appContext } from "@/server/context";
import { budgetStatus } from "@/server/ai/client";
import { listChatActions, listChatMessages } from "@/server/ai/chat/harness";
import { openingQuestion } from "@/server/ai/chat/interview";
import { transcript } from "@/server/ai/chat/render";
import { getLatestInterview, listAnswers, stageConversation, type Interview } from "@/server/repo/interviews";
import { getCurrentProfile, getPreferences } from "@/server/repo/profile";
import { interviewReady } from "@/server/cv/interview-build";
import { baseCvData } from "@/server/cv/view";
import { runningBuildBaseCv } from "@/server/tasks/handlers/build-base-cv";
import { Card } from "@/components/ui/card";
import { ChatPanel } from "@/components/jobs/chat-panel";
import { StageRail } from "@/components/interview/stage-rail";
import { RecordDrawer, type RecordGroup } from "@/components/interview/record-drawer";
import { SkillsCard } from "@/components/interview/skills-card";
import { GenerateCard } from "@/components/interview/generate-card";
import { ChatStageControls, PinRole, RoleTabs } from "@/components/interview/chat-stage";
import { ContactForm, CurrentForm, EducationForm, LanguagesForm, RolesForm, SetupForm, TargetForm } from "@/components/interview/stage-forms";
import { formatUsd } from "@/lib/format";
import { resolveTaskModel, type Connection } from "@/shared/ai-settings";
import { INTERVIEW_STAGES, answerRole, interviewFormSchema, roleStageKey, rolesInOrder, type ChatStage, type InterviewStage, type StageStatus } from "@/shared/schemas/interview";

/** Profile → Build by interview: the guided CV builder. */

function chatItems(db: ReturnType<typeof appContext>["db"], interview: Interview, stage: ChatStage, ref: string | null) {
  const link = stageConversation(db, interview.id, stage, stage === "role_deep" ? ref : null);
  const conversation = link ? db.select().from(conversations).where(eq(conversations.id, link.conversationId)).get() : undefined;
  if (!conversation) return { items: [], conversation: null };
  return { items: transcript(listChatMessages({ db }, conversation.id), listChatActions({ db }, conversation.id)), conversation };
}

export default async function InterviewPage({ searchParams }: PageProps<"/profile/interview">) {
  const t = await getTranslations("interview");
  const tCv = await getTranslations("cv");
  const locale = await getLocale();
  const query = await searchParams;
  const { db, user, ai, settings } = appContext();
  const latest = getLatestInterview(db, user.id);
  // "Start a new interview" after a finished one goes through setup again (?new=1).
  const interview = latest && latest.status !== "abandoned" && !(query.new === "1" && latest.status === "completed") ? latest : null;
  const header = (
    <header className="flex flex-col gap-1">
      <p className="text-sm">
        <Link href="/profile" className="text-muted underline">
          {t("back")}
        </Link>
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="text-muted">{t("subtitle")}</p>
    </header>
  );

  if (!interview) {
    const prefs = getPreferences(db, user.id);
    const country = prefs.markets.find((m) => m.primary)?.country ?? "AU";
    const setup = interviewFormSchema.parse({ setup: { language: locale === "ko" ? "ko" : "en", country } }).setup;
    return (
      <>
        {header}
        <SetupForm interviewId={null} initial={setup} />
      </>
    );
  }

  const { form } = interview;
  const stage: InterviewStage = interview.status === "completed" ? "review" : (interview.stage as InterviewStage);
  const answers = listAnswers(db, interview.id, { includePrivate: true });
  const roles = rolesInOrder(form);
  const roleStatus = (id: string) => (interview.stages[roleStageKey(id)] ?? "pending") as StageStatus;
  const requested = typeof query.role === "string" ? roles.find((r) => r.id === query.role) : undefined;
  const role = requested ?? roles.find((r) => roleStatus(r.id) === "pending") ?? roles[0] ?? null;
  const budget = budgetStatus(ai);
  const connection = resolveTaskModel(settings, "cvInterview").connection;

  const roleLabel = (id: string | null) => {
    const r = form.roles.find((x) => x.id === id);
    return r ? `${r.title || t("untitledRole")}${r.company ? ` — ${r.company}` : ""}` : t("drawer.general");
  };
  const groups: RecordGroup[] = [
    ...roles.map((r) => ({ key: r.id, label: roleLabel(r.id), answers: answers.filter((a) => answerRole(form, a) === r.id) })),
    { key: "general", label: t("drawer.general"), answers: answers.filter((a) => !answerRole(form, a)) },
    // Answers about a role that was removed from the role table: kept for the record, never used.
    { key: "removed", label: t("drawer.removedRole"), answers: answers.filter((a) => { const ref = answerRole(form, a); return !!ref && !form.roles.some((r) => r.id === ref); }) },
  ].map((g) => ({ ...g, answers: g.answers.map((a) => ({ id: a.id, topic: a.topic, quote: a.quote, private: a.private, edited: a.origin === "user_edit" })) }));

  const chat = (chatStage: ChatStage, ref: string | null, status: StageStatus, nextRole: string | null, next: InterviewStage) => {
    const { items, conversation } = chatItems(db, interview, chatStage, ref);
    const roleForm = ref ? (form.roles.find((r) => r.id === ref) ?? null) : null;
    return (
      <Card className="flex flex-col gap-4">
        <ChatPanel
          key={`${chatStage}-${ref ?? "current"}`}
          scope={{ kind: "cv_interview", interviewId: interview.id, stage: chatStage, experienceRef: ref, opening: openingQuestion(interview.language, chatStage, roleForm) }}
          items={items}
          hasConversation={!!conversation}
          provider={conversation ? (conversation.provider as Connection) : null}
          activeConnection={connection}
        />
        {interview.status === "in_progress" && (
          <ChatStageControls interviewId={interview.id} stage={chatStage} statusKey={chatStage === "role_deep" ? roleStageKey(ref!) : "current"} status={status} nextRole={nextRole} nextStage={next} />
        )}
      </Card>
    );
  };

  let main: ReactNode;
  switch (stage) {
    case "setup":
      main = <SetupForm interviewId={interview.id} initial={form.setup} />;
      break;
    case "target":
      main = <TargetForm interviewId={interview.id} initial={form.target} country={form.setup.country} />;
      break;
    case "current": {
      const saved = !!form.current.title || !["employed", "self_employed"].includes(form.current.status);
      main = (
        <>
          <CurrentForm interviewId={interview.id} initial={form.current} />
          {saved ? chat("current", null, (interview.stages.current ?? "pending") as StageStatus, null, "roles") : <p className="text-sm text-muted">{t("current.saveFirst")}</p>}
        </>
      );
      break;
    }
    case "roles":
      main = <RolesForm interviewId={interview.id} initial={form.roles} quick={form.setup.depth === "quick"} />;
      break;
    case "role_deep":
      main = role ? (
        <>
          <PinRole id={role.id} />
          <RoleTabs roles={roles.map((r) => ({ id: r.id, label: roleLabel(r.id), status: roleStatus(r.id) }))} selected={role.id} />
          {chat("role_deep", role.id, roleStatus(role.id), roles.find((r) => r.id !== role.id && roleStatus(r.id) === "pending")?.id ?? null, "education")}
        </>
      ) : (
        <p className="text-sm text-muted">{t("roleChat.noRoles")}</p>
      );
      break;
    case "education":
      main = <EducationForm interviewId={interview.id} initial={form} />;
      break;
    case "languages":
      main = <LanguagesForm interviewId={interview.id} initial={form.languages} />;
      break;
    case "contact":
      main = <ContactForm interviewId={interview.id} initial={form.contact} />;
      break;
    case "review": {
      const ready = interviewReady(interview);
      main = (
        <>
          <SkillsCard interviewId={interview.id} skills={form.skills} />
          <GenerateCard
            interviewId={interview.id}
            missing={ready.ok ? [] : ready.missing}
            hasProfile={!!getCurrentProfile(db, user.id)}
            completed={interview.status === "completed"}
            runningTaskId={runningBuildBaseCv(db, user.id)}
            base={interview.baseDocId ? baseCvData(db, user.id, { summaryLabel: tCv("where.summary") }) : null}
          />
        </>
      );
      break;
    }
  }

  const statuses = Object.fromEntries(INTERVIEW_STAGES.map((s) => [s, interview.stages[s] as StageStatus | undefined]));
  return (
    <>
      {header}
      <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
        <aside>
          <StageRail
            interviewId={interview.id}
            current={stage}
            statuses={statuses}
            answerCount={answers.filter((a) => !a.private).length}
            spendToday={formatUsd(budget.todayUsd, locale)}
            budgetWarning={budget.warning}
            locked={interview.status === "completed"}
          />
        </aside>
        <div className="flex min-w-0 flex-col gap-4" data-stage={stage}>
          {main}
          <RecordDrawer interviewId={interview.id} groups={groups} open={stage === "review"} />
        </div>
      </div>
    </>
  );
}
