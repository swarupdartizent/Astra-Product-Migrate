import { Badge, Tooltip } from '@/ui';
import { UNVALIDATED_TEXT } from './model';

/** "Unvalidated": the adapter has not yet run against a real estate or target. */
export function UnvalidatedBadge() {
  return (
    <Tooltip content={UNVALIDATED_TEXT}>
      <span
        // Focusable so keyboard users reach the explanation; it is also in the accessible name.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        aria-label={`Unvalidated: ${UNVALIDATED_TEXT}`}
      >
        <Badge tone="warning">Unvalidated</Badge>
      </span>
    </Tooltip>
  );
}
