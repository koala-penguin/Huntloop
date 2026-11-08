import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";

/** Marks AI output that the demo simulator wrote (`simulated === true`). Unknown (null) shows nothing. */
export function DemoOutputBadge({ simulated }: { simulated: boolean | null | undefined }) {
  const t = useTranslations("common");
  if (simulated !== true) return null;
  return <Badge tone="warning">{t("demoOutput")}</Badge>;
}
