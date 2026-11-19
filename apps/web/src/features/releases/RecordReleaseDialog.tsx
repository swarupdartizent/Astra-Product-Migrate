import { useState } from 'react';
import { useRecordRelease } from '@/api/releases';
import type { ReleaseDetail } from '@/api/releases-types';
import { FormDialog } from '@/app/FormDialog';
import { hasErrors, mergeFieldErrors } from '@/lib/forms';
import { Callout, Field, Input, Textarea } from '@/ui';
import {
  RELEASE_NAME_MAX,
  RELEASE_REASON_MAX,
  RELEASE_REASON_MIN,
  releaseErrors,
  type ReleaseField,
} from './model';

/**
 * Records a release (POST /releases): the server scores the golden suites now and compares them
 * with the latest released record. Nothing fell → Released; anything fell → Blocked, with each
 * regression. Records are append-only.
 */
export function RecordReleaseDialog({
  baselineName,
  onClose,
  onRecorded,
}: {
  /** The latest released record, which this release is compared with; null before the first. */
  baselineName: string | null;
  onClose: () => void;
  onRecorded: (release: ReleaseDetail) => void;
}) {
  const record = useRecordRelease();
  const [v, setV] = useState<Record<ReleaseField, string>>({ name: '', reason: '' });
  const [submitted, setSubmitted] = useState(false);
  const clientErrors = releaseErrors(v);
  const errors = mergeFieldErrors(clientErrors, record.error, submitted);
  const set = (k: ReleaseField, value: string) => {
    setV((x) => ({ ...x, [k]: value }));
    if (record.error) record.reset();
  };
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Record release"
      description="The golden suites are scored now and compared with the latest released scorecard. The result is recorded and cannot be edited."
      submitLabel="Evaluate and record"
      pending={record.isPending}
      error={record.error}
      fields={['name', 'reason']}
      progress="Scoring the golden suites and comparing them with the baseline…"
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        record.mutate(
          { name: v.name.trim(), reason: v.reason.trim() },
          { onSuccess: (r) => onRecorded(r) },
        );
      }}
    >
      <Callout tone="info" title="A release with any fallen measure is recorded as Blocked">
        {baselineName
          ? `It is compared with ${baselineName}. If any measure fell below it, or a measure or suite disappeared, the release is recorded as Blocked with each regression, and ${baselineName} stays the baseline.`
          : 'No release has been recorded yet, so there is nothing to compare with: this release becomes the first baseline.'}
      </Callout>
      <Field
        label="Release name"
        help={`2–${String(RELEASE_NAME_MAX)} characters: letters, digits, dots, underscores or hyphens, starting with a letter or digit. A released name cannot be used again.`}
        error={errors.name}
        required
      >
        <Input
          value={v.name}
          maxLength={RELEASE_NAME_MAX}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => set('name', e.target.value)}
        />
      </Field>
      <Field
        label="Reason"
        help={`At least ${String(RELEASE_REASON_MIN)} characters. Kept with the release and in the audit log.`}
        error={errors.reason}
        required
      >
        <Textarea
          value={v.reason}
          rows={3}
          maxLength={RELEASE_REASON_MAX}
          onChange={(e) => set('reason', e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}
