import { Badge } from '@/components/ui/badge';
import type { QueueItemType } from '@/lib/finance/core/queue/types';

// kin's badge has no warning/info variants; map to the available ones.
type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';
type BadgeConfig = { label: string; variant: BadgeVariant };

const BADGE_CONFIG = {
  sku_resolution: { label: 'SKU Resolution', variant: 'secondary' },
  ambiguous_match: { label: 'Ambiguous Match', variant: 'outline' },
  unmatched_txn: { label: 'Unmatched', variant: 'destructive' },
  flagged_receipt: { label: 'Flagged Receipt', variant: 'secondary' },
} as const satisfies Record<QueueItemType, BadgeConfig>;

interface QueueBadgeProps {
  type: QueueItemType;
}

export function QueueBadge({ type }: QueueBadgeProps) {
  const config: BadgeConfig = BADGE_CONFIG[type] ?? { label: type, variant: 'outline' };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
