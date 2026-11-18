import type { Tone } from '@/ui';

export const JOB_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  succeeded: { label: 'Finished', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export function jobStatus(status: string): { label: string; tone: Tone } {
  return JOB_STATUS[status] ?? { label: status, tone: 'neutral' };
}
