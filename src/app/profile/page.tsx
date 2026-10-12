import { getTranslations } from "next-intl/server";
import { appContext } from "@/server/context";
import { getCurrentProfile, getPreferences } from "@/server/repo/profile";
import { CvUpload } from "@/components/profile/cv-upload";
import { ProfileEditor } from "@/components/profile/profile-editor";
import { PreferencesEditor } from "@/components/profile/preferences-editor";
import { ProfileTabs } from "@/components/profile/profile-tabs";

export default async function ProfilePage() {
  const t = await getTranslations("profile");
  const { db, user } = appContext();
  const profile = getCurrentProfile(db, user.id);
  const prefs = getPreferences(db, user.id);

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted">{t("subtitle")}</p>
      </header>

      {profile ? (
        <ProfileTabs
          defaultValue="profile"
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
                />
              ),
            },
            { value: "preferences", label: t("tabPreferences"), content: <PreferencesEditor initial={prefs} /> },
            { value: "cv", label: t("tabCv"), content: <CvUpload replacing /> },
          ]}
        />
      ) : (
        <>
          <CvUpload replacing={false} />
          <PreferencesEditor initial={prefs} />
        </>
      )}
    </>
  );
}
