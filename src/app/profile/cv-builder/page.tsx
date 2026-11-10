import type { ReactNode } from "react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { conversations } from "@/server/db/schema";
import { appContext } from "@/server/context";
import { budgetStatus } from "@/server/ai/client";
import { listChatActions, listChatMessages } from "@/server/ai/chat/harness";
import { MIN_TOOLSET, conversationOpening, cvBuilderOpening } from "@/server/ai/chat/cv-builder";
import { transcript } from "@/server/ai/chat/render";
import { getLatestCvBuilder, listAnswers, stageConversation, type CvBuilder } from "@/server/repo/cv-builder";
import { getCurrentProfile, getPreferences } from "@/server/repo/profile";
import { cvBuilderReadiness } from "@/server/cv/cv-builder-build";
import { baseCvData } from "@/server/cv/view";
import { runningBuildBaseCv } from "@/server/tasks/handlers/build-base-cv";
import { Card } from "@/components/ui/card";
import { ChatPanel } from "@/components/jobs/chat-panel";
import { StageRail } from "@/components/cv-builder/stage-rail";
import { RecordDrawer, type RecordGroup } from "@/components/cv-builder/record-drawer";
import { SkillsCard } from "@/components/cv-builder/skills-card";
import { GenerateCard } from "@/components/cv-builder/generate-card";
import { ChatStageControls, PinRole, RoleTabs } from "@/components/cv-builder/chat-stage";
import { SetupForm } from "@/components/cv-builder/stage-forms";
import { DataStageControls, OnFile } from "@/components/cv-builder/data-stage";
import { ContactChat } from "@/components/cv-builder/contact-chat";
import { formatUsd } from "@/lib/format";
import { resolveTaskModel, type Connection } from "@/shared/ai-settings";
import {
  CV_BUILDER_STAGES,
  answerRole,
  cardValueOf,
  cvBuilderFormSchema,
  roleStageKey,
  rolesInOrder,
  type ChatStage,
  type ConversationStage,
  type DataChatStage,
  type CvBuilderStage,
  type StageStatus,
} from "@/shared/schemas/cv-builder";

/** Profile → CV-building interview: the guided CV builder. */

function chatItems(db: ReturnType<typeof appContext>["db"], builder: CvBuilder, stage: ConversationStage, ref: string | null) {
  const link = stageConversation(db, builder.id, stage, stage === "role_deep" ? ref : null);
  const conversation = link ? db.select().from(conversations).where(eq(conversations.id, link.conversationId)).get() : undefined;
  // A chat with an interviewer too old for this step is replaced on the next message; while the
  // CV-builder session is still going, show the new opening instead (a finished CV-builder session keeps its transcript to read).
  if (!conversation || (builder.status === "in_progress" && conversation.toolsetVersion < MIN_TOOLSET[stage])) return { items: [], conversation: null, opening: cvBuilderOpening(builder, stage, ref) };
  // The first question stays the one that was asked, whatever has been saved since.
  const opening = conversationOpening(db, conversation.id) ?? cvBuilderOpening(builder, stage, ref);
  return { items: transcript(listChatMessages({ db }, conversation.id), listChatActions({ db }, conversation.id)), conversation, opening };
}

export default async function CvBuilderPage({ searchParams }: PageProps<"/profile/cv-builder">) {
  const t = await getTranslations("cvBuilder");
  const tCv = await getTranslations("cv");
  const locale = await getLocale();
  const query = await searchParams;
  const { db, user, ai, settings } = appContext();
  const latest = getLatestCvBuilder(db, user.id);
  // "Start a new CV-builder session" after a finished one goes through setup again (?new=1).
  const builder = latest && latest.status !== "abandoned" && !(query.new === "1" && latest.status === "completed") ? latest : null;
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

  if (!builder) {
    const prefs = getPreferences(db, user.id);
    const country = prefs.markets.find((m) => m.primary)?.country ?? "AU";
    const setup = cvBuilderFormSchema.parse({ setup: { language: locale === "ko" ? "ko" : "en", country } }).setup;
    return (
      <>
        {header}
        <SetupForm initial={setup} />
      </>
    );
  }

  const { form } = builder;
  const stage: CvBuilderStage = builder.status === "completed" ? "review" : (builder.stage as CvBuilderStage);
  const answers = listAnswers(db, builder.id, { includePrivate: true });
  const roles = rolesInOrder(form);
  const roleStatus = (id: string) => (builder.stages[roleStageKey(id)] ?? "pending") as StageStatus;
  const requested = typeof query.role === "string" ? roles.find((r) => r.id === query.role) : undefined;
  const role = requested ?? roles.find((r) => roleStatus(r.id) === "pending") ?? roles[0] ?? null;
  const budget = budgetStatus(ai);
  const connection = resolveTaskModel(settings, "cvBuilder").connection;

  const roleLabel = (id: string | null) => {
    const r = form.roles.find((x) => x.id === id);
    return r ? `${r.title || t("untitledRole")}${r.company ? ` — ${r.company}` : ""}` : t("drawer.general");
  };
  const groups: RecordGroup[] = [
    ...roles.map((r) => ({ key: r.id, label: roleLabel(r.id), answers: answers.filter((a) => answerRole(form, a) === r.id) })),
    { key: "general", label: t("drawer.general"), answers: answers.filter((a) => !answerRole(form, a)) },
    // Answers about a role that was removed from the role table: kept for the record, never used.
    { key: "removed", label: t("drawer.removedRole"), answers: answers.filter((a) => { const ref = answerRole(form, a); return !!ref && !form.roles.some((r) => r.id === ref); }) },
  ].map((g) => ({ ...g, answers: g.answers.map((a) => ({ id: a.id, topic: a.topic, quote: a.quote, polished: a.polished, private: a.private, edited: a.origin === "user_edit" })) }));

  const inProgress = builder.status === "in_progress";
  const card = { country: form.setup.country, cvLanguage: form.contact.cvLanguage || builder.language, quick: form.setup.depth === "quick" };
  const panel = (chatStage: ConversationStage, ref: string | null, status: StageStatus) => {
    const { items, conversation, opening } = chatItems(db, builder, chatStage, ref);
    return (
      <ChatPanel
        key={`${chatStage}-${ref ?? "current"}`}
        scope={{ kind: "cv_builder", cvBuilderId: builder.id, stage: chatStage, experienceRef: ref, opening, status, card }}
        items={items}
        hasConversation={!!conversation}
        provider={conversation ? (conversation.provider as Connection) : null}
        activeConnection={connection}
      />
    );
  };
  /** A story chat: the current situation (with what is on file about the job under it), or one role. */
  const chat = (chatStage: ChatStage, ref: string | null, status: StageStatus, nextRole: string | null, next: CvBuilderStage) => (
    <Card className="flex flex-col gap-4">
      {panel(chatStage, ref, status)}
      {chatStage === "current" && <OnFile cvBuilderId={builder.id} stage="current" value={cardValueOf(form, "current")} context={card} editable={inProgress} />}
      {inProgress && <ChatStageControls cvBuilderId={builder.id} stage={chatStage} statusKey={chatStage === "role_deep" ? roleStageKey(ref!) : "current"} status={status} nextRole={nextRole} nextStage={next} />}
    </Card>
  );
  /** A data step: the chat, what is saved so far, and Continue. */
  const dataChat = (dataStage: DataChatStage, skippable: boolean) => {
    const status = (builder.stages[dataStage] ?? "pending") as StageStatus;
    return (
      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{dataStage === "setup" ? t("stageTitle.setup") : t(`${dataStage}.title`)}</h2>
          <p className="text-sm text-muted">{t(`${dataStage}.description`)}</p>
        </div>
        {panel(dataStage, null, status)}
        <OnFile cvBuilderId={builder.id} stage={dataStage} value={cardValueOf(form, dataStage)} context={card} editable={inProgress} />
        {inProgress && <DataStageControls cvBuilderId={builder.id} stage={dataStage} status={status} skippable={skippable} />}
      </Card>
    );
  };

  let main: ReactNode;
  switch (stage) {
    case "setup":
      main = dataChat("setup", false);
      break;
    case "target":
      main = dataChat("target", false);
      break;
    case "current":
      main = chat("current", null, (builder.stages.current ?? "pending") as StageStatus, null, "roles");
      break;
    case "roles":
      main = dataChat("roles", false);
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
      main = dataChat("education", true);
      break;
    case "languages":
      main = dataChat("languages", true);
      break;
    case "contact":
      main = <ContactChat cvBuilderId={builder.id} initial={form.contact} />;
      break;
    case "review": {
      const ready = cvBuilderReadiness(builder);
      main = (
        <>
          <SkillsCard cvBuilderId={builder.id} skills={form.skills} />
          <GenerateCard
            cvBuilderId={builder.id}
            missing={ready.ok ? [] : ready.missing}
            hasProfile={!!getCurrentProfile(db, user.id)}
            completed={builder.status === "completed"}
            runningTaskId={runningBuildBaseCv(db, user.id)}
            base={builder.baseDocId ? baseCvData(db, user.id, { summaryLabel: tCv("where.summary") }) : null}
          />
        </>
      );
      break;
    }
  }

  const statuses = Object.fromEntries(CV_BUILDER_STAGES.map((s) => [s, builder.stages[s] as StageStatus | undefined]));
  return (
    <>
      {header}
      <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
        <aside>
          <StageRail
            cvBuilderId={builder.id}
            current={stage}
            statuses={statuses}
            answerCount={answers.filter((a) => !a.private).length}
            spendToday={formatUsd(budget.todayUsd, locale)}
            budgetWarning={budget.warning}
            locked={builder.status === "completed"}
          />
        </aside>
        <div className="flex min-w-0 flex-col gap-4" data-stage={stage}>
          {main}
          <RecordDrawer cvBuilderId={builder.id} groups={groups} open={stage === "review"} />
        </div>
      </div>
    </>
  );
}
