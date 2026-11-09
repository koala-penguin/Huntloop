"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/form";
import { addSkillAction, toggleSkillAction } from "@/app/profile/interview/actions";
import { SKILL_CATEGORIES } from "@/shared/schemas/profile";
import type { InterviewSkill } from "@/shared/schemas/interview";

/** Skills heard in the interview: only the ones the user ticks reach the profile and CV. */
export function SkillsCard({ interviewId, skills }: { interviewId: number; skills: InterviewSkill[] }) {
  const t = useTranslations("interview");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [category, setCategory] = useState<string>("tool");
  // Shown ticked at once; the server's answer arrives with the refresh.
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const run = (fn: () => Promise<unknown>) =>
    start(async () => {
      await fn();
      router.refresh();
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("skills.title")}</CardTitle>
        <CardDescription>{t("skills.description")}</CardDescription>
      </CardHeader>
      {skills.length === 0 ? (
        <p className="text-sm text-muted">{t("skills.empty")}</p>
      ) : (
        <ul className="flex flex-wrap gap-x-5 gap-y-2">
          {skills.map((s) => (
            <li key={s.name}>
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={ticked[s.name] ?? s.ticked}
                  onChange={(e) => {
                    const value = e.target.checked;
                    setTicked((t) => ({ ...t, [s.name]: value }));
                    run(() => toggleSkillAction(interviewId, s.name, value));
                  }}
                />
                {s.name}
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="interview-skill">{t("skills.add")}</Label>
          <Input id="interview-skill" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="interview-skill-category">{t("skills.category")}</Label>
          <Select id="interview-skill-category" value={category} onChange={(e) => setCategory(e.target.value)}>
            {SKILL_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`skillCategory.${c}`)}
              </option>
            ))}
          </Select>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={pending || !name.trim()}
          onClick={() =>
            run(async () => {
              await addSkillAction(interviewId, name, category);
              setName("");
            })
          }
        >
          <Plus className="size-3.5" aria-hidden />
          {t("skills.addButton")}
        </Button>
      </div>
    </Card>
  );
}
