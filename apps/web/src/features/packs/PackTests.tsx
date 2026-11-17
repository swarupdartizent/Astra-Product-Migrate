import { CircleCheck, CircleX, FlaskConical, Send, ShieldCheck, Archive } from 'lucide-react';
import { useState } from 'react';
import { useDeprecatePack, usePublishPack, useReviewPack, useTestPack } from '@/api/packs';
import type { PackDetail } from '@/api/types';
import { FormDialog } from '@/app/FormDialog';
import { FormError } from '@/app/FormError';
import { usePermissions } from '@/app/permissions';
import { hasErrors, mergeFieldErrors, reasonError, type FieldErrors } from '@/lib/forms';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Textarea,
  Timestamp,
  toast,
  Tooltip,
} from '@/ui';
import s from '../shared.module.css';
import { publishBlocker } from './model';
import styles from './Packs.module.css';

export function PackTests({ pack }: { pack: PackDetail }) {
  const { can } = usePermissions();
  const canPublish = can('pack:publish');
  const canReview = can('pack:review');
  const test = useTestPack(pack.name, pack.version);
  const publish = usePublishPack(pack.name, pack.version);
  const [reviewing, setReviewing] = useState(false);
  const [deprecating, setDeprecating] = useState(false);
  const report = pack.test_report;
  const blocker = publishBlocker(pack);
  const isDraft = pack.status === 'draft';

  return (
    <div className={s.stack}>
      <Card flush aria-labelledby="tests-title">
        <CardHeader
          titleId="tests-title"
          title="Test report"
          description={
            report ? (
              <>
                {report.passed ? 'All checks passed' : 'Some checks failed'} · ran{' '}
                <Timestamp value={report.ran_at} />
              </>
            ) : (
              'Built-in checks plus the tests declared in pack.yaml.'
            )
          }
          actions={
            canPublish && isDraft ? (
              <Button
                size="sm"
                leadingIcon={<FlaskConical aria-hidden="true" />}
                loading={test.isPending}
                onClick={() =>
                  test.mutate(undefined, {
                    onSuccess: (r) =>
                      r.passed
                        ? toast.success('All checks passed')
                        : toast.error('Some checks failed', {
                            description: 'See the test report.',
                          }),
                  })
                }
              >
                Run tests
              </Button>
            ) : null
          }
        />
        {test.isError ? (
          <CardBody>
            <FormError error={test.error} />
          </CardBody>
        ) : null}
        {report ? (
          <ul className={styles.checks} aria-label="Checks">
            {report.checks.map((c, i) => (
              <li key={i} className={styles.check}>
                {c.passed ? (
                  <CircleCheck className={styles.checkIcon} data-passed="true" aria-hidden="true" />
                ) : (
                  <CircleX className={styles.checkIcon} data-passed="false" aria-hidden="true" />
                )}
                <span className={s.cellStack}>
                  <span className={s.cellPrimary}>
                    <span className="sr-only">{c.passed ? 'Passed: ' : 'Failed: '}</span>
                    {c.name}
                  </span>
                  <span className={`${s.muted} ${s.small}`}>{c.message}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            compact
            icon={<FlaskConical />}
            title="Tests have not run"
            body={isDraft ? 'Run the tests before publishing.' : undefined}
          />
        )}
      </Card>

      <Card aria-labelledby="release-title">
        <CardHeader
          titleId="release-title"
          title="Release"
          description="Publishing freezes this version: its files and digest never change again. Projects pin exact versions."
        />
        <CardBody className={s.stackSm}>
          {pack.type === 'compliance' ? (
            <Callout tone="info" title="Compliance review">
              Compliance packs must be reviewed by a named compliance specialist before they are
              published. The reviewer may be external (for example an auditor); record who they are
              and their role.
              {pack.reviewed_by_name ? (
                <>
                  {' '}
                  Reviewed by <strong>{pack.reviewed_by_name}</strong>
                  {pack.reviewed_by_role ? ` (${pack.reviewed_by_role})` : ''}.
                </>
              ) : null}
            </Callout>
          ) : null}
          {publish.isError ? <FormError error={publish.error} /> : null}
          {isDraft && blocker ? <p className={`${s.muted} ${s.small}`}>{blocker}</p> : null}
        </CardBody>
        <CardFooter>
          {pack.type === 'compliance' && isDraft && canReview ? (
            <Button
              leadingIcon={<ShieldCheck aria-hidden="true" />}
              onClick={() => setReviewing(true)}
            >
              {pack.reviewed_by_name ? 'Update review' : 'Record review'}
            </Button>
          ) : null}
          {isDraft && canPublish ? (
            <Tooltip content={blocker ?? 'Publish this version'}>
              <Button
                variant="primary"
                leadingIcon={<Send aria-hidden="true" />}
                aria-disabled={blocker !== null}
                aria-describedby={blocker ? 'publish-blocker' : undefined}
                loading={publish.isPending}
                onClick={() => {
                  if (blocker) return;
                  publish.mutate(undefined, {
                    onSuccess: (p) => toast.success(`${p.name}@${p.version} published`),
                  });
                }}
              >
                Publish
              </Button>
            </Tooltip>
          ) : null}
          {blocker ? (
            <span id="publish-blocker" className="sr-only">
              {blocker}
            </span>
          ) : null}
          {pack.status === 'published' && canPublish ? (
            <Button
              variant="danger"
              leadingIcon={<Archive aria-hidden="true" />}
              onClick={() => setDeprecating(true)}
            >
              Deprecate
            </Button>
          ) : null}
        </CardFooter>
      </Card>
      {reviewing ? <ReviewDialog pack={pack} onClose={() => setReviewing(false)} /> : null}
      {deprecating ? <DeprecateDialog pack={pack} onClose={() => setDeprecating(false)} /> : null}
    </div>
  );
}

function ReviewDialog({ pack, onClose }: { pack: PackDetail; onClose: () => void }) {
  const review = useReviewPack(pack.name, pack.version);
  const [form, setForm] = useState({ reviewer_name: '', reviewer_role: '' });
  const [submitted, setSubmitted] = useState(false);
  const clientErrors: FieldErrors<'reviewer_name' | 'reviewer_role'> = {};
  if (form.reviewer_name.trim().length < 3)
    clientErrors.reviewer_name = 'Enter the reviewer’s full name.';
  if (form.reviewer_role.trim().length < 3)
    clientErrors.reviewer_role = 'Describe their role and qualification.';
  const errors = mergeFieldErrors(clientErrors, review.error, submitted);
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Record compliance review of ${pack.name}@${pack.version}`}
      description="Record the named compliance specialist who reviewed this pack's controls. They may be outside your organisation. The review is written to the audit log."
      submitLabel="Record review"
      pending={review.isPending}
      error={review.error}
      fields={['reviewer_name', 'reviewer_role']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        review.mutate(
          { reviewer_name: form.reviewer_name.trim(), reviewer_role: form.reviewer_role.trim() },
          {
            onSuccess: () => {
              toast.success('Review recorded');
              onClose();
            },
          },
        );
      }}
    >
      <Field label="Reviewer name" error={errors.reviewer_name} required>
        <Input
          value={form.reviewer_name}
          onChange={(e) => setForm((f) => ({ ...f, reviewer_name: e.target.value }))}
          autoComplete="off"
          maxLength={200}
        />
      </Field>
      <Field
        label="Reviewer role"
        help="For example: “Data protection specialist, external auditor”."
        error={errors.reviewer_role}
        required
      >
        <Input
          value={form.reviewer_role}
          onChange={(e) => setForm((f) => ({ ...f, reviewer_role: e.target.value }))}
          autoComplete="off"
          maxLength={200}
        />
      </Field>
    </FormDialog>
  );
}

function DeprecateDialog({ pack, onClose }: { pack: PackDetail; onClose: () => void }) {
  const deprecate = useDeprecatePack(pack.name, pack.version);
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const clientErrors: FieldErrors<'reason'> = {};
  const r = reasonError(reason);
  if (r) clientErrors.reason = r;
  const errors = mergeFieldErrors(clientErrors, deprecate.error, submitted);
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      tone="danger"
      size="sm"
      title={`Deprecate ${pack.name}@${pack.version}?`}
      description="Projects that pin this version keep working but get a warning to upgrade. New blueprints should pick a newer version."
      submitLabel="Deprecate"
      pending={deprecate.isPending}
      error={deprecate.error}
      fields={['reason']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        deprecate.mutate(reason.trim(), {
          onSuccess: () => {
            toast.success(`${pack.name}@${pack.version} deprecated`);
            onClose();
          },
        });
      }}
    >
      <Field
        label="Reason"
        help="At least 10 characters. Recorded in the audit log."
        error={errors.reason}
        required
      >
        <Textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={1000}
        />
      </Field>
    </FormDialog>
  );
}
