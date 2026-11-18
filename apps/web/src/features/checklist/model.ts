import type { ChecklistItem, ChecklistStatus } from '@/api/upgrade-types';
import type { Tone } from '@/ui';

export const CHECKLIST_STATUS: Record<ChecklistStatus, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'neutral' },
  in_progress: { label: 'In progress', tone: 'info' },
  done: { label: 'Done', tone: 'success' },
  not_applicable: { label: 'Not applicable', tone: 'neutral' },
};

export const STATUS_OPTIONS = (Object.keys(CHECKLIST_STATUS) as ChecklistStatus[]).map((s) => ({
  value: s,
  label: CHECKLIST_STATUS[s].label,
}));

export function checklistStatus(status: string) {
  return (
    (CHECKLIST_STATUS as Record<string, { label: string; tone: Tone } | undefined>)[status] ?? {
      label: status,
      tone: 'neutral' as Tone,
    }
  );
}

export function isClosing(status: string): boolean {
  return status === 'done' || status === 'not_applicable';
}

/** "customer_it_security_lead" → "Customer IT security lead". */
export function roleLabel(role: string): string {
  const w = role.replace(/_/g, ' ').replace(/\bit\b/g, 'IT');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** Items grouped by area in first-seen order (the API sorts by category, then key). */
export function groupByArea(
  items: readonly ChecklistItem[],
): { area: string; title: string; items: ChecklistItem[] }[] {
  const m = new Map<string, { area: string; title: string; items: ChecklistItem[] }>();
  for (const i of items) {
    const g = m.get(i.category) ?? { area: i.category, title: i.category_title, items: [] };
    g.items.push(i);
    m.set(i.category, g);
  }
  return [...m.values()];
}

/**
 * Client-side mirror of the API's closing rules: an item is closed by its owner, so it needs one
 * (409), and closing needs a note saying how it was done or why it does not apply (422).
 */
export function closeProblem(
  item: Pick<ChecklistItem, 'owner_user_id' | 'note'>,
  next: { status: string; note: string; owner: string | null },
): { field: 'owner_user_id' | 'note'; message: string } | null {
  if (!isClosing(next.status)) return null;
  if (!next.owner && !item.owner_user_id) {
    return {
      field: 'owner_user_id',
      message: 'Assign an owner first: an item is closed by its owner.',
    };
  }
  if (!(next.note.trim() || item.note.trim())) {
    return { field: 'note', message: 'Say how the item was done, or why it does not apply.' };
  }
  return null;
}
