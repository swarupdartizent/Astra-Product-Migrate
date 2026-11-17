import { Check, CircleCheck, GitCommitHorizontal, History, X } from 'lucide-react';
import { useState } from 'react';
import { useVersion, useVersionDecision, useVersions } from '@/api/blueprints';
import type { Project, VersionDetail } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CodeBlock,
  EmptyState,
  Field,
  KeyValueList,
  Mono,
  Skeleton,
  StatusPill,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import {
  approvalProgress,
  approvalSummary,
  decisionReasonError,
  shortSha,
  versionStatus,
} from './model';
import { useRoleLabel } from './useRoleLabel';
import styles from './Blueprint.module.css';

export function VersionsTab({
  project,
  selected,
  onSelect,
}: {
  project: Project;
  selected: number | null;
  onSelect: (n: number) => void;
}) {
  const versions = useVersions(project.id);
  const current = selected ?? versions.data?.[0]?.number ?? null;

  if (versions.isPending) return <Skeleton height="12rem" />;
  if (versions.isError) {
    return (
      <ApiErrorView
        error={versions.error}
        title="Could not load versions"
        onRetry={() => void versions.refetch()}
      />
    );
  }
  if (versions.data.length === 0) {
    return (
      <EmptyState
        icon={<History />}
        title="No versions yet"
        body="Save the blueprint from the editor to create version 1."
      />
    );
  }

  return (
    <div className={styles.versionsLayout}>
      <Card flush aria-labelledby="versions-title">
        <CardHeader titleId="versions-title" title="Versions" description="Newest first." />
        <ul className={styles.versionList}>
          {versions.data.map((v) => {
            const st = versionStatus(v.status);
            return (
              <li key={v.number}>
                <button
                  type="button"
                  className={styles.versionButton}
                  aria-current={v.number === current ? 'true' : undefined}
                  onClick={() => onSelect(v.number)}
                >
                  <span className={s.row}>
                    <strong>Version {v.number}</strong>
                    <StatusPill tone={st.tone}>{st.label}</StatusPill>
                  </span>
                  <span className={s.small}>{v.message}</span>
                  <span className={`${s.muted} ${s.xs}`}>
                    {v.author_name} · <Timestamp value={v.created_at} /> ·{' '}
                    <Mono>{shortSha(v.commit_sha)}</Mono>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
      {current !== null ? <VersionPanel project={project} number={current} /> : null}
    </div>
  );
}

function VersionPanel({ project, number }: { project: Project; number: number }) {
  const version = useVersion(project.id, number);
  const roleLabel = useRoleLabel();
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null);

  if (version.isPending) return <Skeleton height="20rem" />;
  if (version.isError) {
    return (
      <ApiErrorView
        error={version.error}
        title={`Could not load version ${number}`}
        onRetry={() => void version.refetch()}
      />
    );
  }
  const v = version.data;
  const st = versionStatus(v.status);
  const progress = approvalProgress(v.required_roles, v.approvals);
  const canDecide = v.can_approve_as.length > 0;

  return (
    <div className={s.stack}>
      <Card aria-labelledby="version-detail">
        <CardHeader
          titleId="version-detail"
          title={`Version ${v.number}`}
          description={v.message}
          actions={<StatusPill tone={st.tone}>{st.label}</StatusPill>}
        />
        <CardBody className={s.stackSm}>
          <KeyValueList
            items={[
              { key: 'author', label: 'Saved by', value: v.author_name },
              { key: 'time', label: 'Saved', value: <Timestamp value={v.created_at} /> },
              {
                key: 'commit',
                label: 'Commit',
                value: (
                  <span className={s.row}>
                    <GitCommitHorizontal aria-hidden="true" style={{ width: '1rem' }} />
                    <Mono title={v.commit_sha}>{shortSha(v.commit_sha)}</Mono>
                    {v.git_verified ? (
                      <Badge tone="success" icon={<Check />}>
                        Stored in git
                      </Badge>
                    ) : (
                      <Badge tone="danger">Not found in git</Badge>
                    )}
                  </span>
                ),
              },
              { key: 'template', label: 'Template', value: v.template },
            ]}
          />
          {v.status === 'approved' ? (
            <Callout tone="success" title="Approved and locked">
              This version cannot change. Any change is saved as a new version, which needs approval
              again.
            </Callout>
          ) : null}
        </CardBody>
      </Card>

      <Card aria-labelledby="approvals-title">
        <CardHeader
          titleId="approvals-title"
          title="Approvals"
          description={approvalSummary(progress, roleLabel)}
        />
        <CardBody className={s.stackSm}>
          <ul className={styles.progressList} aria-label="Required approvers">
            {progress.items.map((item) => (
              <li key={item.role} className={s.row}>
                {item.status === 'approved' ? (
                  <CircleCheck
                    aria-hidden="true"
                    style={{ width: '1rem', color: 'var(--color-success-solid)' }}
                  />
                ) : item.status === 'rejected' ? (
                  <X
                    aria-hidden="true"
                    style={{ width: '1rem', color: 'var(--color-danger-solid)' }}
                  />
                ) : (
                  <span aria-hidden="true" style={{ width: '1rem' }}>
                    ○
                  </span>
                )}
                <span>{roleLabel(item.role)}</span>
                <span className={`${s.muted} ${s.small}`}>
                  {item.status === 'pending'
                    ? 'pending'
                    : `${item.status} by ${item.by ?? 'unknown'}`}
                </span>
              </li>
            ))}
          </ul>
          {v.approvals.length > 0 ? (
            <section aria-label="Decisions recorded">
              <h3 className={s.cellPrimary} style={{ marginBottom: 'var(--space-2)' }}>
                Recorded decisions
              </h3>
              <ul className={styles.progressList}>
                {v.approvals.map((a, i) => (
                  <li key={i} className={s.cellStack}>
                    <span>
                      <strong>{a.user_name}</strong>{' '}
                      {a.decision === 'approve' ? 'approved' : 'rejected'} as {roleLabel(a.role)} ·{' '}
                      <Timestamp value={a.decided_at} />
                    </span>
                    {a.reason ? (
                      <span className={`${s.muted} ${s.small}`}>“{a.reason}”</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {v.status === 'draft' && !v.validation.ok ? (
            <Callout tone="warning" title={`${v.validation.blocking} blocking problem(s)`}>
              The server refuses approval until they are fixed in a new version.
            </Callout>
          ) : null}
        </CardBody>
        {canDecide ? (
          <CardFooter>
            <Button
              variant="danger"
              leadingIcon={<X aria-hidden="true" />}
              onClick={() => setDeciding('reject')}
            >
              Reject
            </Button>
            <Button
              variant="primary"
              leadingIcon={<Check aria-hidden="true" />}
              onClick={() => setDeciding('approve')}
            >
              Approve as {v.can_approve_as.map(roleLabel).join(' or ')}
            </Button>
          </CardFooter>
        ) : null}
      </Card>

      <Card aria-labelledby="version-validation">
        <CardHeader
          titleId="version-validation"
          title="Validation"
          description={
            v.validation.ok
              ? 'No blocking problems.'
              : `${v.validation.blocking} blocking, ${v.validation.warnings} warning(s).`
          }
        />
        {v.validation.issues.length > 0 ? (
          <CardBody>
            <ul className={styles.progressList}>
              {v.validation.issues.map((issue, i) => (
                <li key={i} className={s.cellStack}>
                  <span className={s.row}>
                    <StatusPill tone={issue.severity === 'blocking' ? 'danger' : 'warning'}>
                      {issue.severity === 'blocking' ? 'Blocking' : 'Warning'}
                    </StatusPill>
                    <Mono className={s.xs}>{issue.path}</Mono>
                  </span>
                  <span className={s.small}>{issue.message}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        ) : null}
      </Card>

      <CodeBlock label={`Version ${v.number} (YAML)`} code={v.yaml_text} maxHeight="32rem" />

      {deciding ? (
        <DecisionDialog
          project={project}
          version={v}
          approve={deciding === 'approve'}
          roleLabel={roleLabel}
          onClose={() => setDeciding(null)}
        />
      ) : null}
    </div>
  );
}

function DecisionDialog({
  project,
  version,
  approve,
  roleLabel,
  onClose,
}: {
  project: Project;
  version: VersionDetail;
  approve: boolean;
  roleLabel: (key: string) => string;
  onClose: () => void;
}) {
  const decide = useVersionDecision(project.id, version.number);
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const clientError = decisionReasonError(approve, reason);
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      tone={approve ? 'default' : 'danger'}
      title={approve ? `Approve version ${version.number}` : `Reject version ${version.number}`}
      description={
        approve
          ? `You approve as ${version.can_approve_as.map(roleLabel).join(' or ')}. When every required role has approved, the version is locked and becomes the approved blueprint.`
          : 'Rejecting ends approval of this version. Changes are made in a new version.'
      }
      submitLabel={approve ? 'Approve' : 'Reject'}
      pending={decide.isPending}
      error={decide.error}
      fields={['reason']}
      onSubmit={() => {
        setSubmitted(true);
        if (clientError) return;
        decide.mutate(
          { approve, reason: reason.trim() },
          {
            onSuccess: (v) => {
              toast.success(
                approve
                  ? v.status === 'approved'
                    ? `Version ${v.number} approved and locked`
                    : 'Approval recorded'
                  : `Version ${v.number} rejected`,
              );
              onClose();
            },
          },
        );
      }}
    >
      <Field
        label="Reason"
        help={
          approve ? 'Optional. Recorded with your approval.' : 'Required. At least 10 characters.'
        }
        error={submitted ? clientError : undefined}
        required={!approve}
      >
        <Textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={2000}
        />
      </Field>
    </FormDialog>
  );
}
