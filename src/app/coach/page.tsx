import { getTranslations } from "next-intl/server";
import { appContext } from "@/server/context";
import { getCoachConversation } from "@/server/ai/chat/coach";
import { listChatActions, listChatMessages } from "@/server/ai/chat/harness";
import { transcript } from "@/server/ai/chat/render";
import { Card } from "@/components/ui/card";
import { ChatPanel } from "@/components/jobs/chat-panel";
import { resolveTaskModel, type Connection } from "@/shared/ai-settings";

export default async function CoachPage() {
  const t = await getTranslations("chat.coach");
  const { db, ai, settings } = appContext();
  const conversation = getCoachConversation(ai);
  const items = conversation ? transcript(listChatMessages({ db }, conversation.id), listChatActions({ db }, conversation.id)) : [];
  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted">{t("subtitle")}</p>
      </header>
      <Card>
        <ChatPanel
          scope={{ kind: "coach" }}
          items={items}
          hasConversation={!!conversation}
          otherProvider={conversation && conversation.provider !== resolveTaskModel(settings, "coach").connection ? (conversation.provider as Connection) : null}
        />
      </Card>
    </>
  );
}
