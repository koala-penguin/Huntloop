import { getTranslations } from "next-intl/server";
import { appContext } from "@/server/context";
import { getCurrentProfile, getPreferences } from "@/server/repo/profile";
import { CvUpload } from "@/components/profile/cv-upload";
import { ProfileEditor } from "@/components/profile/profile-editor";
import { PreferencesEditor } from "@/components/profile/preferences-editor";
import { SimpleTabs } from "@/components/ui/tabs";
import { LinkedinPanel } from "@/components/cv/linkedin-panel";
import { linkedinPanelData } from "@/server/cv/view";
import { DemoOutputBadge } from "@/components/ui/demo-output-badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { getLatestInterview } from "@/server/repo/interviews";

export default async function ProfilePage({ searchParams }: PageProps<"/profile">) {
  const t = await getTranslations("profile");
  const tLinkedin = await getTranslations("linkedin");
  const query = await searchParams;
  const { db, user } = appContext();
  const profile = getCurrentProfile(db, user.id);
  const prefs = getPreferences(db, user.id);
  const linkedin = linkedinPanelData(db, user.id, { headline: tLinkedin("section.headline"), about: tLinkedin("section.about"), skills: tLinkedin("section.skills") });
  const primary = prefs.markets.find((m) => m.primary)?.country ?? prefs.markets[0]?.country;
  const interview = getLatestInterview(db, user.id);
  const fromInterview = !!profile && interview?.status === "completed" && interview.profileVersion === profile.version;
  const interviewCard = (
    <Card>
      <CardHeader>
        <CardTitle>{t("interviewTitle")}</CardTitle>
        <CardDescription>{t(profile ? "interviewDescriptionExisting" : "interviewDescription")}</CardDescription>
      </CardHeader>
      <div>
        <Button asChild size="sm" variant={profile ? "secondary" : "primary"}>
          <Link href="/profile/interview">{interview?.status === "in_progress" ? t("interviewResume") : t("interviewStart")}</Link>
        </Button>
      </div>
    </Card>
  );

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          {t("title")} <DemoOutputBadge simulated={profile?.simulated} />
        </h1>
        <p className="text-muted">{t("subtitle")}</p>
      </header>

      {profile ? (
        <SimpleTabs
          defaultValue={query.tab === "linkedin" ? "linkedin" : "profile"}
          tabs={[
            {
              value: "profile",
              label: t("tabProfile"),
              content: (
                <ProfileEditor
                  version={profile.version}
                  cvText={profile.cvText}
                  data={profile.data}
                  preferenceCountries={prefs.markets.map((m) => m.country)}
                  careerRecord={fromInterview}
                />
              ),
            },
            { value: "preferences", label: t("tabPreferences"), content: <PreferencesEditor initial={prefs} /> },
            {
              value: "cv",
              label: t("tabCv"),
              content: (
                <div className="flex flex-col gap-4">
                  <CvUpload replacing />
                  {interviewCard}
                </div>
              ),
            },
            {
              value: "linkedin",
              label: t("tabLinkedin"),
              content: <LinkedinPanel key={linkedin.doc?.id ?? "none"} {...linkedin} defaultLanguage={primary === "KR" ? "ko" : "en"} />,
            },
          ]}
        />
      ) : (
        <>
          <CvUpload replacing={false} />
          {interviewCard}
          <PreferencesEditor initial={prefs} />
        </>
      )}
    </>
  );
}
