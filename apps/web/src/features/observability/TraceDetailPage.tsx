import { ExternalLink } from 'lucide-react';
import { useMemo, useState, type CSSProperties } from 'react';
import { useTrace } from '@/api/observability';
import type { Span } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { RequirePermission } from '@/app/RequirePermission';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  CopyButton,
  KeyValueList,
  Mono,
  PageHeader,
  Skeleton,
  StatusPill,
  Timestamp,
} from '@/ui';
import s from '../shared.module.css';
import { formatCost, formatDuration, layoutWaterfall } from './model';
import styles from './Observability.module.css';

export function TraceDetailPage({ traceId }: { traceId: string }) {
  return (
    <RequirePermission permission="observability:read">
      <TraceDetail traceId={traceId} />
    </RequirePermission>
  );
}

function TraceDetail({ traceId }: { traceId: string }) {
  const trace = useTrace(traceId);
  const layout = useMemo(() => layoutWaterfall(trace.data?.spans ?? []), [trace.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const root = layout.rows[0]?.span;
  useDocumentTitle(root ? `Trace ${root.name}` : 'Trace');

  const breadcrumbs = [
    { label: 'Observability', to: '/observability' as const },
    { label: root?.name ?? 'Trace' },
  ];

  if (trace.isPending) {
    return (
      <div aria-busy="true">
        <span className="sr-only">Loading trace…</span>
        <PageHeader breadcrumbs={breadcrumbs} title={<Skeleton width="18rem" height="1.75rem" />} />
        <Skeleton height="16rem" />
      </div>
    );
  }
  if (trace.isError) {
    return (
      <>
        <PageHeader breadcrumbs={breadcrumbs} title="Trace" description={<Mono>{traceId}</Mono>} />
        <ApiErrorView
          error={trace.error}
          title="Could not load this trace"
          onRetry={() => void trace.refetch()}
          retrying={trace.isFetching}
        />
      </>
    );
  }

  const data = trace.data;
  const selected = layout.rows.find((r) => r.span.span_id === selectedId)?.span ?? null;
  const errors = data.spans.filter((sp) => sp.status === 'error').length;
  const costs = data.spans.map((sp) => sp.cost_usd).filter((c): c is number => c !== null);
  const totalCost = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null;

  return (
    <>
      <PageHeader
        breadcrumbs={breadcrumbs}
        title={root?.name ?? 'Trace'}
        meta={
          <StatusPill tone={errors > 0 ? 'danger' : 'success'}>
            {errors > 0 ? `${errors} error${errors === 1 ? '' : 's'}` : 'OK'}
          </StatusPill>
        }
        description={
          <span className={s.row}>
            <Mono>{data.trace_id}</Mono>
            <CopyButton value={data.trace_id} label="Copy trace ID" />
          </span>
        }
        actions={
          data.jaeger_url ? (
            <Button asChild variant="secondary" size="sm">
              <a href={data.jaeger_url} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden="true" />
                Open in Jaeger
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
          ) : null
        }
      />
      <div className={s.stack}>
        <Card aria-labelledby="trace-summary">
          <CardHeader titleId="trace-summary" title="Summary" />
          <CardBody>
            <KeyValueList
              items={[
                {
                  key: 'start',
                  label: 'Started',
                  value: root ? <Timestamp value={root.started_at} format="absolute" /> : null,
                },
                { key: 'duration', label: 'Duration', value: formatDuration(layout.totalMs) },
                { key: 'spans', label: 'Spans', value: data.spans.length.toLocaleString() },
                { key: 'cost', label: 'Model cost', value: formatCost(totalCost) },
              ]}
            />
          </CardBody>
        </Card>

        <Card flush aria-labelledby="waterfall-title">
          <CardHeader
            titleId="waterfall-title"
            title="Spans"
            description="Bars are placed by start time and sized by duration. Nested spans ran inside their parent. Select a span to see its attributes."
          />
          <div className={styles.scale} aria-hidden="true">
            <span>Operation</span>
            <span className={styles.scaleTicks}>
              <span>0</span>
              <span>{formatDuration(layout.totalMs / 2)}</span>
              <span>{formatDuration(layout.totalMs)}</span>
            </span>
          </div>
          <ul className={styles.waterfall} aria-label="Spans in start order">
            {layout.rows.map((row) => {
              const sp = row.span;
              const isSelected = sp.span_id === selectedId;
              return (
                <li key={sp.span_id}>
                  <button
                    type="button"
                    className={styles.spanRow}
                    aria-pressed={isSelected}
                    aria-controls="span-detail"
                    onClick={() => setSelectedId(isSelected ? null : sp.span_id)}
                  >
                    <span
                      className={styles.spanLabel}
                      style={{ '--depth': row.depth } as CSSProperties}
                    >
                      <Badge>{sp.category}</Badge>
                      <span className={styles.spanName}>{sp.name}</span>
                      <span className="sr-only">
                        , starts at {formatDuration(row.offsetMs)}, lasts{' '}
                        {formatDuration(sp.duration_ms)}
                        {sp.status === 'error' ? ', failed' : ''}
                        {row.depth > 0 ? `, nested level ${row.depth}` : ''}
                      </span>
                    </span>
                    <span className={styles.timeline} aria-hidden="true">
                      <span
                        className={styles.spanBar}
                        data-status={sp.status}
                        style={{ left: `${row.offsetPct}%`, width: `${row.widthPct}%` }}
                      />
                      <span
                        className={styles.spanDuration}
                        style={
                          row.offsetPct + row.widthPct > 80
                            ? { right: `${100 - row.offsetPct}%`, paddingRight: 'var(--space-1)' }
                            : { left: `${row.offsetPct + row.widthPct}%` }
                        }
                      >
                        {formatDuration(sp.duration_ms)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        <div id="span-detail" aria-live="polite">
          {selected ? <SpanDetail span={selected} /> : null}
        </div>
      </div>
    </>
  );
}

function SpanDetail({ span: sp }: { span: Span }) {
  return (
    <Card aria-labelledby="span-detail-title">
      <CardHeader
        titleId="span-detail-title"
        title={sp.name}
        description={<Mono>{sp.span_id}</Mono>}
        actions={
          <StatusPill tone={sp.status === 'error' ? 'danger' : 'success'}>
            {sp.status === 'error' ? 'Error' : 'OK'}
          </StatusPill>
        }
      />
      <CardBody className={s.stackSm}>
        <KeyValueList
          items={[
            { key: 'category', label: 'Category', value: sp.category },
            {
              key: 'started',
              label: 'Started',
              value: <Timestamp value={sp.started_at} format="absolute" />,
            },
            { key: 'duration', label: 'Duration', value: formatDuration(sp.duration_ms) },
            { key: 'stage', label: 'Stage', value: sp.stage },
            { key: 'agent', label: 'Agent', value: sp.agent },
            { key: 'model', label: 'Model', value: sp.model },
            {
              key: 'cost',
              label: 'Model cost',
              value: sp.cost_usd === null ? null : formatCost(sp.cost_usd),
            },
            {
              key: 'parent',
              label: 'Parent span',
              value: sp.parent_span_id ? <Mono>{sp.parent_span_id}</Mono> : null,
            },
          ]}
        />
        <CodeBlock
          label="Attributes (JSON)"
          code={JSON.stringify(sp.attributes, null, 2)}
          maxHeight="20rem"
        />
      </CardBody>
    </Card>
  );
}
