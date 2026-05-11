import type { ReactNode } from "react";

export type MobileTab = "graph" | "info" | "files";

interface Props {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
}

const tabs: { id: MobileTab; label: string; icon: ReactNode }[] = [
  {
    id: "graph",
    label: "Graph",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <circle cx="6" cy="7" r="2" />
        <circle cx="18" cy="7" r="2" />
        <circle cx="12" cy="17" r="2" />
        <path strokeLinecap="round" d="M7.6 8.5L11 15.5M16.4 8.5L13 15.5M8 7h8" />
      </svg>
    ),
  },
  {
    id: "info",
    label: "Info",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <circle cx="12" cy="12" r="9" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 11v5M12 8h.01" />
      </svg>
    ),
  },
  {
    id: "files",
    label: "Files",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 6.5A1.5 1.5 0 0 1 5.5 5h3.382a1.5 1.5 0 0 1 1.342.83l.671 1.34A1.5 1.5 0 0 0 12.236 8H18.5A1.5 1.5 0 0 1 20 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"
        />
      </svg>
    ),
  },
];

export default function MobileBottomNav({ activeTab, onTabChange }: Props) {
  return (
    <nav className="flex shrink-0 bg-surface border-t border-border-subtle">
      {tabs.map((tab) => {
        const active = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className={`relative flex-1 flex flex-col items-center justify-center gap-1 py-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors ${
              active ? "text-accent" : "text-text-muted hover:text-text-secondary"
            }`}
            aria-current={active ? "page" : undefined}
          >
            <span className="w-5 h-5">{tab.icon}</span>
            {tab.label}
            {active && (
              <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-px bg-accent" />
            )}
          </button>
        );
      })}
    </nav>
  );
}
