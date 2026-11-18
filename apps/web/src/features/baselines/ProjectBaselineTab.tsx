import { Link } from '@tanstack/react-router';
import { Pin } from 'lucide-react';
import { useState } from 'react';
import { useBaselines, usePinBaseline, useProjectBaseline } from '@/api/targets';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { hasErrors, mergeFieldErrors, type FieldErrors } from '@/lib/forms';
import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  EmptyState,
  Field,
  KeyValueList,
  Mono,
  Select,
  Skeleton,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import { SyntheticBadge } from './BaselinesPage';

export function ProjectBaselineTab({ project }: { project: Project }) {
  const pin = useProjectBaseline(project.id);
  const canPin = project.permissions.includes('blueprint:edit');
  const [pinning, setPinning] = useState(false);
  if (pin.isPending) return <Skeleton height="8rem" />;
  if (pin.isError)
    return (
      <ApiErrorView
        error={pin.error}
        title="Could not load the baseline"
        onRetry={() => void pin.refetch()}
      />
    );
  const b = pin.data.pinned;
  return (
    <Card aria-labelledby="proj-baseline">
      <CardHeader
        titleId="proj-baseline"
        title="Target baseline"
        description="The target metadata this project designs against. The version delta compares with it."
        actions={b ? <SyntheticBadge synthetic={b.synthetic} /> : null}
      />
      <CardBody>
        {b ? (
          <KeyValueList
            items={[
              {
                key: 'name',
                label: 'Baseline',
                value: (
                  <Link to="/baselines/$baselineId" params={{ baselineId: b.id }}>
                    {b.name}
                  </Link>
                ),
              },
              { key: 'adapter', label: 'Adapter', value: <Mono>{b.adapter_name}</Mono> },
              { key: 'version', label: 'Product version', value: b.product_version },
              { key: 'objects', label: 'Objects', value: b.object_count.toLocaleString() },
              {
                key: 'pinned',
                label: 'Pinned',
                value: (
                  <span className={s.cellStack}>
                    <span>
                      {pin.data.pinned_by ?? 'unknown'}
                      {pin.data.pinned_at ? (
                        <>
                          {' · '}
                          <Timestamp value={pin.data.pinned_at} />
                        </>
                      ) : null}
                    </span>
                    {pin.data.reason ? (
                      <span className={`${s.muted} ${s.small}`}>“{pin.data.reason}”</span>
                    ) : null}
                  </span>
                ),
              },
            ]}
          />
        ) : (
          <EmptyState
            compact
            title="No baseline pinned"
            body="Pin the target baseline this project should design against."
          />
        )}
      </CardBody>
      {canPin ? (
        <CardFooter>
          <Button leadingIcon={<Pin aria-hidden="true" />} onClick={() => setPinning(true)}>
            {b ? 'Change baseline' : 'Pin a baseline'}
          </Button>
        </CardFooter>
      ) : null}
      {pinning ? (
        <PinDialog project={project} current={b?.id ?? null} onClose={() => setPinning(false)} />
      ) : null}
    </Card>
  );
}

function PinDialog({
  project,
  current,
  onClose,
}: {
  project: Project;
  current: string | null;
  onClose: () => void;
}) {
  const baselines = useBaselines();
  const save = usePinBaseline(project.id);
  const [id, setId] = useState(current ?? '');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const clientErrors: FieldErrors<'baseline_id' | 'reason'> = {};
  if (!id) clientErrors.baseline_id = 'Choose a baseline.';
  if (reason.trim().length < 5)
    clientErrors.reason = `Say why (at least 5 characters, ${reason.trim().length} so far).`;
  const errors = mergeFieldErrors(clientErrors, save.error, submitted);
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Pin a target baseline"
      submitLabel="Pin baseline"
      pending={save.isPending}
      error={save.error}
      fields={['baseline_id', 'reason']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        save.mutate(
          { baseline_id: id, reason: reason.trim() },
          {
            onSuccess: () => {
              toast.success('Baseline pinned');
              onClose();
            },
          },
        );
      }}
    >
      <Field label="Baseline" error={errors.baseline_id} required>
        <Select
          options={(baselines.data ?? []).map((b) => ({
            value: b.id,
            label: `${b.adapter_name} / ${b.name} (${b.product_version})${b.synthetic ? ' · synthetic' : ''}`,
          }))}
          value={id}
          onValueChange={setId}
          placeholder={baselines.isPending ? 'Loading…' : 'Choose a baseline'}
        />
      </Field>
      <Field label="Reason" error={errors.reason} required>
        <Textarea
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={1000}
        />
      </Field>
    </FormDialog>
  );
}
