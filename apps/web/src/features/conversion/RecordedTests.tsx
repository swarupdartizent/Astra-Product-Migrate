import { FlaskConical, Plus, Trash } from 'lucide-react';
import { useState } from 'react';
import { isApiError } from '@/api/errors';
import type { Project } from '@/api/types';
import { useAddConversionTest, useConversionTests, useDeleteConversionTest } from '@/api/upgrade';
import type { ConversionTest } from '@/api/upgrade-types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Mono,
  PlainText,
  Select,
  Skeleton,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from '../discovery/Discovery.module.css';
import {
  buildTest,
  EMPTY_TEST,
  EXPECT_KINDS,
  show,
  testFieldOf,
  type ExpectKind,
  type TestForm,
} from './model';

/** Input/output cases recorded for source objects; every conversion run replays them. */
export function RecordedTests({ project }: { project: Project }) {
  const tests = useConversionTests(project.id);
  const remove = useDeleteConversionTest(project.id);
  const canEdit =
    project.permissions.includes('source:manage') || project.permissions.includes('golden:run');
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<ConversionTest | null>(null);
  const byObject = new Map<string, ConversionTest[]>();
  for (const t of tests.data ?? [])
    byObject.set(t.object_name, [...(byObject.get(t.object_name) ?? []), t]);

  return (
    <Card aria-labelledby="conv-tests">
      <CardHeader
        titleId="conv-tests"
        title="Recorded tests"
        description="Cases recorded from the source system: inputs, rows set up first, and the expected result. Every conversion run replays them against the converted code on the workbench."
        actions={
          canEdit ? (
            <Button leadingIcon={<Plus aria-hidden="true" />} onClick={() => setAdding(true)}>
              Record a test
            </Button>
          ) : null
        }
      />
      <CardBody className={s.stackSm}>
        {tests.isPending ? (
          <Skeleton height="4rem" />
        ) : tests.isError ? (
          <ApiErrorView
            error={tests.error}
            title="Could not load recorded tests"
            compact
            onRetry={() => void tests.refetch()}
          />
        ) : tests.data.length === 0 ? (
          <EmptyState compact icon={<FlaskConical />} title="No recorded tests" />
        ) : (
          [...byObject.entries()].map(([obj, list]) => (
            <section key={obj} aria-label={`Tests for ${obj}`}>
              <h3 className={styles.sectionTitle}>
                <Mono>{obj}</Mono> ({list.length})
              </h3>
              <ul className={styles.plainList}>
                {list.map((t) => (
                  <li key={t.id} className={s.cellStack}>
                    <span className={s.row}>
                      <strong>{t.name}</strong>
                      <span className={`${s.muted} ${s.xs}`}>
                        {t.created_by ?? 'unknown'} · <Timestamp value={t.created_at} />
                      </span>
                      {canEdit ? (
                        <IconButton
                          size="sm"
                          label={`Delete test ${t.name}`}
                          icon={<Trash aria-hidden="true" />}
                          onClick={() => setDeleting(t)}
                        />
                      ) : null}
                    </span>
                    <details>
                      <summary className={s.small}>Case</summary>
                      <PlainText label={`Case ${t.name}`}>{show(t.body)}</PlainText>
                    </details>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </CardBody>
      {adding ? <AddTestDialog project={project} onClose={() => setAdding(false)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
        tone="danger"
        title={`Delete test ${deleting?.name ?? ''}?`}
        description="Later conversion runs no longer replay it. Runs already finished keep their results."
        confirmLabel="Delete test"
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.id);
          toast.success('Test deleted');
        }}
      />
    </Card>
  );
}

function AddTestDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const add = useAddConversionTest(project.id);
  const [f, setF] = useState<TestForm>(EMPTY_TEST);
  const [submitted, setSubmitted] = useState(false);
  const built = buildTest(f);
  const server: Partial<Record<string, string>> = {};
  const mapped: string[] = [];
  if (isApiError(add.error)) {
    for (const e of add.error.fieldErrorList) {
      const field = testFieldOf(e.field);
      if (field) mapped.push(e.field);
      if (field && !server[field]) server[field] = `${e.field}: ${e.message}`;
    }
  }
  const err = (k: keyof typeof built.errors) =>
    (submitted ? built.errors[k] : undefined) ?? server[k];
  const set = <K extends keyof TestForm>(k: K, v: TestForm[K]) => {
    setF((p) => ({ ...p, [k]: v }));
    if (add.error) add.reset();
  };
  const kind = EXPECT_KINDS.find((k) => k.value === f.expectKind);
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Record a test"
      description="Values are JSON. The case is stored for this project and replayed by every conversion run."
      submitLabel="Record test"
      size="lg"
      pending={add.isPending}
      error={add.error}
      fields={['object_name', 'name', 'inputs', 'outputs', 'setup', 'expected', ...mapped]}
      onSubmit={() => {
        setSubmitted(true);
        if (!built.body) return;
        add.mutate(built.body, {
          onSuccess: () => {
            toast.success('Test recorded');
            onClose();
          },
        });
      }}
    >
      <div className={s.grid2}>
        <Field label="Source object" help="schema.name" error={err('object_name')} required>
          <Input mono value={f.object_name} onChange={(e) => set('object_name', e.target.value)} />
        </Field>
        <Field label="Test name" error={err('name')} required>
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={200} />
        </Field>
      </div>
      <Field
        label="Inputs"
        help='Parameter name (without @) to value, in call order. For example {"policy_id": 7}.'
        error={err('inputs')}
      >
        <Textarea
          mono
          rows={3}
          spellCheck={false}
          value={f.inputs}
          onChange={(e) => set('inputs', e.target.value)}
        />
      </Field>
      <Field
        label="Output parameters to capture"
        help="Comma-separated names."
        error={err('outputs')}
      >
        <Input mono value={f.outputs} onChange={(e) => set('outputs', e.target.value)} />
      </Field>
      <Field
        label="Rows to set up first"
        help='{"schema.table": [{"column": value}, …]}; inserted before the call.'
        error={err('setup')}
      >
        <Textarea
          mono
          rows={4}
          spellCheck={false}
          value={f.setup}
          onChange={(e) => set('setup', e.target.value)}
        />
      </Field>
      <Field label="Expected" help={kind?.help} required>
        <Select
          options={EXPECT_KINDS.map((k) => ({ value: k.value, label: k.label }))}
          value={f.expectKind}
          onValueChange={(v) => set('expectKind', v as ExpectKind)}
        />
      </Field>
      <Field
        label={f.expectKind === 'error' ? 'Error text' : 'Expected result (JSON)'}
        error={err('expected')}
        required
      >
        <Textarea
          mono
          rows={3}
          spellCheck={false}
          value={f.expected}
          onChange={(e) => set('expected', e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}
