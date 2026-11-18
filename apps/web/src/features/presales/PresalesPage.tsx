import { useNavigate } from '@tanstack/react-router';
import { Calculator, Plus } from 'lucide-react';
import { useState } from 'react';
import { usePublishedPacks } from '@/api/packs';
import { useCreatePresales, usePresalesEstimate, usePresalesEstimates } from '@/api/planning';
import type { PresalesEstimate, Questionnaire } from '@/api/planning-types';
import { useProgrammes } from '@/api/tenancy';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { RequirePermission } from '@/app/RequirePermission';
import { mergeFieldErrors } from '@/lib/forms';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CheckboxGroup,
  EmptyState,
  Field,
  Input,
  KeyValueList,
  Mono,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from '../discovery/Discovery.module.css';
import { packRef } from '../packs/model';
import { formatRange, humanize } from '../plan/model';
import plan from '../plan/Plan.module.css';
import { EMPTY_QUESTIONNAIRE, QUESTION_FIELDS, validatePresales, type PresalesForm } from './model';

export function PresalesPage({ estimateId }: { estimateId: string | null }) {
  useDocumentTitle('Pre-sales estimates');
  return (
    <RequirePermission permission="presales:estimate">
      <PresalesView estimateId={estimateId} />
    </RequirePermission>
  );
}

function PresalesView({ estimateId }: { estimateId: string | null }) {
  const list = usePresalesEstimates();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const selectedId = estimateId ?? list.data?.[0]?.id ?? null;
  const select = (id: string) =>
    void navigate({ to: '/presales', search: { estimate: id }, replace: true });
  return (
    <>
      <PageHeader
        title="Pre-sales estimates"
        description="Size a migration from a short questionnaire and the estimation packs, before any discovery. Every answer is an estimate with its assumptions listed, not a delivery plan."
        actions={
          <Button
            variant="primary"
            leadingIcon={<Plus aria-hidden="true" />}
            onClick={() => setCreating(true)}
          >
            New estimate
          </Button>
        }
      />
      <div className={s.stack}>
        <Card aria-labelledby="ps-list">
          <CardHeader titleId="ps-list" title="Estimates" />
          <CardBody>
            {list.isPending ? (
              <Skeleton height="4rem" />
            ) : list.isError ? (
              <ApiErrorView
                error={list.error}
                title="Could not load estimates"
                compact
                onRetry={() => void list.refetch()}
              />
            ) : list.data.length === 0 ? (
              <EmptyState compact icon={<Calculator />} title="No estimates yet" />
            ) : (
              <ul className={styles.plainList} aria-label="Estimates">
                {list.data.map((e) => (
                  <li key={e.id} className={s.row}>
                    <Button
                      size="sm"
                      variant={e.id === selectedId ? 'secondary' : 'ghost'}
                      aria-pressed={e.id === selectedId}
                      onClick={() => select(e.id)}
                    >
                      {e.name}
                    </Button>
                    <span className={s.small}>{formatRange(e.result.effort_hours)}</span>
                    <span className={`${s.muted} ${s.xs}`}>
                      {e.created_by ?? 'unknown'} · <Timestamp value={e.created_at} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
        {selectedId ? <EstimateDetail id={selectedId} /> : null}
      </div>
      {creating ? (
        <CreateDialog
          onClose={(id) => {
            setCreating(false);
            if (id) select(id);
          }}
        />
      ) : null}
    </>
  );
}

function EstimateDetail({ id }: { id: string }) {
  const q = usePresalesEstimate(id);
  if (q.isPending) return <Skeleton height="16rem" />;
  if (q.isError)
    return (
      <ApiErrorView
        error={q.error}
        title="Could not load the estimate"
        onRetry={() => void q.refetch()}
      />
    );
  return <EstimateResult estimate={q.data} />;
}

export function EstimateResult({ estimate: e }: { estimate: PresalesEstimate }) {
  const r = e.result;
  return (
    <Card aria-labelledby="ps-result">
      <CardHeader
        titleId="ps-result"
        title={e.name}
        description={`Packs: ${e.estimation_packs.join(', ')}`}
      />
      <CardBody className={s.stack}>
        <p className={plan.estimate} role="note">
          {r.label}
        </p>
        <dl className={styles.metrics}>
          <div className={styles.metric}>
            <dt className={styles.metricLabel}>Effort</dt>
            <dd className={styles.metricValue} style={{ fontSize: 'var(--text-md)' }}>
              {formatRange(r.effort_hours)}
            </dd>
          </div>
          <div className={styles.metric}>
            <dt className={styles.metricLabel}>Duration</dt>
            <dd className={styles.metricValue}>{r.duration_weeks} weeks</dd>
          </div>
          <div className={styles.metric}>
            <dt className={styles.metricLabel}>Waves</dt>
            <dd className={styles.metricValue}>{r.waves.length}</dd>
          </div>
        </dl>
        <section aria-labelledby="ps-assumptions">
          <h3 id="ps-assumptions" className={styles.sectionTitle}>
            Assumptions ({r.assumptions.length})
          </h3>
          <ul className={plan.evidence}>
            {r.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </section>
        {r.unestimated.length > 0 ? (
          <Callout tone="warning" title="Not estimated">
            No estimation rule covers: {r.unestimated.join(', ')}. These are not in the total.
          </Callout>
        ) : null}
        <section aria-labelledby="ps-outline">
          <h3 id="ps-outline" className={styles.sectionTitle}>
            Scope outline
          </h3>
          <KeyValueList
            items={r.scope_outline.map((o) => ({
              key: o.elements,
              label: `${o.count.toLocaleString()} ${humanize(o.elements).toLowerCase()} (${humanize(o.stream)}, ${humanize(o.disposition).toLowerCase()})`,
              value: o.hours
                ? `${formatRange(o.hours)}${o.rule ? ` · rule ${o.rule}` : ''}`
                : 'Not estimated',
            }))}
          />
        </section>
        {r.waves.length > 0 ? (
          <section aria-labelledby="ps-waves">
            <h3 id="ps-waves" className={styles.sectionTitle}>
              Waves
            </h3>
            <KeyValueList
              items={r.waves.map((w) => ({
                key: w.wave,
                label: w.wave,
                value: `${String(w.weeks)} weeks, about ${w.likely_hours.toLocaleString()} likely hours`,
              }))}
            />
          </section>
        ) : null}
        <section aria-labelledby="ps-basis">
          <h3 id="ps-basis" className={styles.sectionTitle}>
            Basis
          </h3>
          <ul className={styles.plainList}>
            {r.basis.map((b) => (
              <li key={b.pack} className={s.row}>
                <Mono className={s.small}>{b.pack}</Mono>
                {b.calibrated ? (
                  <Badge tone="success">Calibrated</Badge>
                ) : (
                  <Badge tone="warning">UNCALIBRATED</Badge>
                )}
                <span className={`${s.muted} ${s.xs}`}>{b.basis}</span>
              </li>
            ))}
          </ul>
        </section>
        {e.sample ? (
          <p className={`${s.muted} ${s.small}`}>
            Counts from the sample extract:{' '}
            {Object.entries(e.sample)
              .map(([k, v]) => `${humanize(k).toLowerCase()} ${String(v)}`)
              .join(', ')}
            .
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

const NONE = '__none__';

function CreateDialog({ onClose }: { onClose: (id: string | null) => void }) {
  const create = useCreatePresales();
  const packs = usePublishedPacks();
  const programmes = useProgrammes();
  const [f, setF] = useState<PresalesForm>({
    name: '',
    programme_id: '',
    estimation_packs: [],
    questionnaire: { ...EMPTY_QUESTIONNAIRE },
    sample_extract_yaml: '',
  });
  const [submitted, setSubmitted] = useState(false);
  const v = validatePresales(f);
  const errors = mergeFieldErrors(v.errors, create.error, submitted);
  const qErrors = (k: keyof Questionnaire) => errors[`questionnaire.${k}`];
  const patterns = (packs.data ?? []).filter((p) => p.type === 'pattern');
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose(null);
      }}
      title="New pre-sales estimate"
      description="The answers and the result are kept. Leave a count at 0 when the estate has none."
      submitLabel="Estimate"
      size="lg"
      pending={create.isPending}
      error={create.error}
      fields={[
        'name',
        'programme_id',
        'estimation_packs',
        'sample_extract_yaml',
        ...QUESTION_FIELDS.map((q) => `questionnaire.${q.key}`),
      ]}
      onSubmit={() => {
        setSubmitted(true);
        if (!v.body) return;
        create.mutate(v.body, {
          onSuccess: (e) => {
            toast.success('Estimate ready');
            onClose(e.id);
          },
        });
      }}
    >
      <div className={s.grid2}>
        <Field label="Name" error={errors.name} required>
          <Input
            value={f.name}
            onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))}
            maxLength={200}
          />
        </Field>
        <Field label="Programme" error={errors.programme_id}>
          <Select
            options={[
              { value: NONE, label: 'None' },
              ...(programmes.data ?? []).map((p) => ({ value: p.id, label: p.name })),
            ]}
            value={f.programme_id || NONE}
            onValueChange={(val) => setF((p) => ({ ...p, programme_id: val === NONE ? '' : val }))}
          />
        </Field>
      </div>
      <CheckboxGroup
        legend="Estimation packs (1 to 5)"
        help="Published pattern packs with estimation rules."
        options={patterns.map((p) => ({
          value: packRef(p),
          label: p.title,
          description: packRef(p),
        }))}
        value={f.estimation_packs}
        onValueChange={(val) => setF((p) => ({ ...p, estimation_packs: val }))}
        maxHeight="10rem"
        error={errors.estimation_packs ?? errors['estimation_packs.0']}
        emptyText={packs.isPending ? 'Loading…' : 'No published pattern packs.'}
      />
      <fieldset className={s.stackSm}>
        <legend className={styles.sectionTitle}>Questionnaire</legend>
        <div className={s.grid2}>
          {QUESTION_FIELDS.map((q) => (
            <Field
              key={q.key}
              label={q.label}
              help={q.help}
              error={qErrors(q.key)}
              required={q.required}
            >
              <Input
                type="number"
                min={0}
                inputMode="decimal"
                value={f.questionnaire[q.key]}
                onChange={(e) =>
                  setF((p) => ({
                    ...p,
                    questionnaire: { ...p.questionnaire, [q.key]: e.target.value },
                  }))
                }
              />
            </Field>
          ))}
        </div>
      </fieldset>
      <Field
        label="Sample extract (optional)"
        help="Estate metadata in the platform's baseline YAML format. When given, its counts replace the questionnaire's."
        error={errors.sample_extract_yaml}
      >
        <Textarea
          mono
          rows={5}
          spellCheck={false}
          value={f.sample_extract_yaml}
          onChange={(e) => setF((p) => ({ ...p, sample_extract_yaml: e.target.value }))}
        />
      </Field>
    </FormDialog>
  );
}
