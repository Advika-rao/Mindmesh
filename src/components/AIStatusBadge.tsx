import React from 'react';
import { CheckCircle2, Database, Cpu, AlertTriangle, Presentation } from 'lucide-react';

export type AIStatusSource = 'ai' | 'cached' | 'local_fallback' | 'demo';

interface AIStatusBadgeProps {
  source: AIStatusSource;
  label: string;
  isQuotaOrRateLimited?: boolean;
  compact?: boolean;
}

export const AIStatusBadge: React.FC<AIStatusBadgeProps> = ({
  source,
  label,
  isQuotaOrRateLimited = false,
  compact = false,
}) => {
  const config = (() => {
    if (source === 'demo') {
      return {
        icon: Presentation,
        classes: 'bg-amber-500/12 border-amber-500/35 text-amber-200',
        iconClass: 'text-amber-400',
      };
    }
    if (source === 'cached') {
      return {
        icon: Database,
        classes: 'bg-sky-500/12 border-sky-500/30 text-sky-200',
        iconClass: 'text-sky-400',
      };
    }
    if (source === 'local_fallback') {
      return isQuotaOrRateLimited
        ? {
            icon: AlertTriangle,
            classes: 'bg-amber-500/12 border-amber-500/35 text-amber-200',
            iconClass: 'text-amber-400',
          }
        : {
            icon: Cpu,
            classes: 'bg-amber-500/12 border-amber-500/30 text-amber-200',
            iconClass: 'text-amber-400',
          };
    }
    return {
      icon: CheckCircle2,
      classes: 'bg-emerald-500/12 border-emerald-500/30 text-emerald-200',
      iconClass: 'text-emerald-400',
    };
  })();

  const Icon = config.icon;

  return (
    <span
      className={`inline-flex items-center gap-1.5 border rounded-md font-medium ${
        compact ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs'
      } ${config.classes}`}
    >
      <Icon className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} shrink-0 ${config.iconClass}`} />
      <span>{label}</span>
    </span>
  );
};
