"use client";

import { Tabs } from "radix-ui";
import type { ReactNode } from "react";

interface TabDef {
  value: string;
  label: string;
  content: ReactNode;
}

export function SimpleTabs({ tabs, defaultValue }: { tabs: TabDef[]; defaultValue: string }) {
  return (
    <Tabs.Root defaultValue={defaultValue} className="flex flex-col gap-4">
      <Tabs.List className="flex gap-1 border-b border-border">
        {tabs.map((tab) => (
          <Tabs.Trigger
            key={tab.value}
            value={tab.value}
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted hover:text-foreground data-[state=active]:border-accent data-[state=active]:font-medium data-[state=active]:text-foreground"
          >
            {tab.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {tabs.map((tab) => (
        <Tabs.Content key={tab.value} value={tab.value}>
          {tab.content}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}
