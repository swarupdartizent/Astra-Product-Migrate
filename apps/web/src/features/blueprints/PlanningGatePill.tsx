import type { PlanningGate } from '@/api/types';
import { StatusPill, Tooltip } from '@/ui';

export function PlanningGatePill({ gate }: { gate: PlanningGate }) {
  return (
    <Tooltip content={gate.reason}>
      <span
        // Focusable so keyboard users reach the reason; it is also in the accessible name.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        aria-label={`${gate.ready ? 'Ready for planning' : 'Not ready for planning'}: ${gate.reason}`}
      >
        <StatusPill tone={gate.ready ? 'success' : 'neutral'}>
          {gate.ready ? 'Ready for planning' : 'Not ready for planning'}
        </StatusPill>
      </span>
    </Tooltip>
  );
}
