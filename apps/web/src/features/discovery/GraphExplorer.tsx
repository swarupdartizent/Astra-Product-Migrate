import { Link, useNavigate } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useGraph, useGraphNode } from '@/api/discovery';
import type { GraphEdge, GraphNode, GraphNodeDetail } from '@/api/discovery-types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  Field,
  Input,
  KeyValueList,
  Mono,
  Select,
  Skeleton,
} from '@/ui';
import s from '../shared.module.css';
import { countText, edgeLabel, groupEdges, humanize, NODE_PAGE, nodeUsage } from './model';
import styles from './Discovery.module.css';

const ALL = '__all__';

export interface GraphExplorerProps {
  runId: string;
  node: string | null;
  unused: boolean;
}

/** Browse the run's knowledge graph: filter nodes, open one, follow its edges. */
export function GraphExplorer({ runId, node, unused }: GraphExplorerProps) {
  const navigate = useNavigate();
  const [stream, setStream] = useState('');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q.trim(), 300);
  const [offset, setOffset] = useState(0);
  const query = {
    ...(stream ? { stream } : {}),
    ...(kind ? { kind } : {}),
    ...(dq ? { q: dq } : {}),
    ...(unused ? { unused: true } : {}),
    offset,
    limit: NODE_PAGE,
  };
  const graph = useGraph(runId, query);
  const streams = graph.data?.streams ?? {};
  const counts = useMemo(() => graph.data?.counts ?? [], [graph.data]);
  const kinds = useMemo(
    () =>
      [...new Set(counts.filter((c) => !stream || c.stream === stream).map((c) => c.kind))].sort(),
    [counts, stream],
  );
  const byStream = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of counts) m.set(c.stream, (m.get(c.stream) ?? 0) + c.nodes);
    return m;
  }, [counts]);

  const select = (id: string | null, nextUnused = unused) =>
    void navigate({
      to: '/discovery-runs/$runId',
      params: { runId },
      search: {
        tab: 'graph',
        ...(id ? { node: id } : {}),
        ...(nextUnused ? { unused: true } : {}),
      },
      replace: true,
    });
  const reset = (fn: () => void) => {
    fn();
    setOffset(0);
  };
  const total = graph.data?.total ?? 0;

  return (
    <div className={styles.graphLayout}>
      <Card flush aria-labelledby="kg-nodes">
        <CardHeader
          titleId="kg-nodes"
          title="Knowledge graph"
          description="Every legacy element discovery found, by migration stream. Select a node to see its usage, concept, target candidate and edges."
        />
        <div className={s.filters} style={{ padding: 'var(--space-3) var(--space-5)' }}>
          <Field label="Stream">
            <Select
              size="sm"
              options={[
                { value: ALL, label: 'All streams' },
                ...Object.entries(streams).map(([k, title]) => ({
                  value: k,
                  label: `${title} (${String(byStream.get(k) ?? 0)})`,
                })),
              ]}
              value={stream || ALL}
              onValueChange={(v) =>
                reset(() => {
                  setStream(v === ALL ? '' : v);
                  setKind('');
                })
              }
            />
          </Field>
          <Field label="Kind">
            <Select
              size="sm"
              options={[
                { value: ALL, label: 'All kinds' },
                ...kinds.map((k) => ({ value: k, label: humanize(k) })),
              ]}
              value={kind || ALL}
              onValueChange={(v) => reset(() => setKind(v === ALL ? '' : v))}
            />
          </Field>
          <Field label="Name contains">
            <Input
              size="sm"
              type="search"
              value={q}
              startAdornment={<Search />}
              onChange={(e) => reset(() => setQ(e.target.value))}
            />
          </Field>
          <Field label="Only unused (flagged for retirement review)" inline>
            <Checkbox
              checked={unused}
              onCheckedChange={(v) => {
                setOffset(0);
                select(node, v === true);
              }}
            />
          </Field>
        </div>
        <CardBody>
          {graph.isError ? (
            <ApiErrorView
              error={graph.error}
              title="Could not load the graph"
              compact
              onRetry={() => void graph.refetch()}
            />
          ) : graph.isPending ? (
            <Skeleton height="16rem" />
          ) : graph.data.nodes.length === 0 ? (
            <EmptyState compact title="No nodes match" />
          ) : (
            <ul
              className={styles.plainList}
              aria-label="Nodes"
              style={{ padding: '0 var(--space-5) var(--space-3)' }}
            >
              {graph.data.nodes.map((n) => (
                <li key={n.id}>
                  <NodeLink runId={runId} node={n} current={n.id === node} unused={unused} />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
        {graph.data ? (
          <div className={s.toolbar} style={{ justifyContent: 'space-between' }}>
            <span className={`${s.muted} ${s.small}`} aria-live="polite">
              {total === 0
                ? 'No nodes'
                : `${String(offset + 1)}–${String(Math.min(offset + NODE_PAGE, total))} of ${total.toLocaleString()}`}
            </span>
            <span className={s.row}>
              <Button
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - NODE_PAGE))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                disabled={offset + NODE_PAGE >= total}
                onClick={() => setOffset(offset + NODE_PAGE)}
              >
                Next
              </Button>
            </span>
          </div>
        ) : null}
      </Card>
      {node ? (
        <NodePanel runId={runId} nodeId={node} streams={streams} unused={unused} />
      ) : (
        <Card aria-labelledby="kg-none">
          <CardHeader titleId="kg-none" title="No node selected" />
          <CardBody>
            <p className={s.muted}>Select a node to see its details and edges.</p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function NodeLink({
  runId,
  node,
  current,
  unused,
}: {
  runId: string;
  node: Pick<GraphNode, 'id' | 'kind' | 'element'> & { usage?: GraphNode['usage'] };
  current?: boolean;
  unused: boolean;
}) {
  const u = nodeUsage(node.usage ?? null);
  return (
    <span className={s.row}>
      <Link
        to="/discovery-runs/$runId"
        params={{ runId }}
        search={{ tab: 'graph', node: node.id, ...(unused ? { unused: true } : {}) }}
        aria-current={current ? 'true' : undefined}
        style={current ? { fontWeight: 600 } : undefined}
      >
        <Mono className={s.small}>{node.element}</Mono>
      </Link>
      <Badge>{humanize(node.kind)}</Badge>
      {u.unused ? <Badge tone="warning">Unused</Badge> : null}
    </span>
  );
}

function NodePanel({
  runId,
  nodeId,
  streams,
  unused,
}: {
  runId: string;
  nodeId: string;
  streams: Record<string, string>;
  unused: boolean;
}) {
  const q = useGraphNode(runId, nodeId);
  if (q.isPending) return <Skeleton height="20rem" />;
  if (q.isError) {
    return (
      <ApiErrorView
        error={q.error}
        title="Could not load this node"
        onRetry={() => void q.refetch()}
      />
    );
  }
  return <NodeDetail runId={runId} detail={q.data} streams={streams} unused={unused} />;
}

export function NodeDetail({
  runId,
  detail,
  streams,
  unused,
}: {
  runId: string;
  detail: GraphNodeDetail;
  streams: Record<string, string>;
  unused: boolean;
}) {
  const n = detail.node;
  const usage = nodeUsage(n.usage);
  const props = Object.entries(n.props ?? {}).filter(([, v]) => v !== null && v !== undefined);
  return (
    <Card aria-labelledby="kg-node">
      <CardHeader
        titleId="kg-node"
        title={n.element}
        description={
          <span className={s.row}>
            <Badge>{humanize(n.kind)}</Badge>
            <span>{streams[n.stream] ?? humanize(n.stream)}</span>
            {usage.unused ? <Badge tone="warning">Flagged for retirement review</Badge> : null}
          </span>
        }
      />
      <CardBody className={s.stack}>
        <KeyValueList
          items={[
            { key: 'id', label: 'Node', value: <Mono className={s.xs}>{n.id}</Mono> },
            {
              key: 'concept',
              label: 'Ontology concept',
              value: n.concept ? (
                <Link to="/ontology/$conceptId" params={{ conceptId: n.concept }}>
                  <Mono>{n.concept}</Mono>
                </Link>
              ) : null,
            },
            {
              key: 'target',
              label: 'Target element (candidate)',
              value: n.target ? <Mono>{n.target}</Mono> : null,
            },
          ]}
        />
        {usage.items.length > 0 ? (
          <section aria-label="Usage">
            <h3 className={styles.sectionTitle}>Usage</h3>
            <KeyValueList items={usage.items.map(([k, v]) => ({ key: k, label: k, value: v }))} />
          </section>
        ) : null}
        {props.length > 0 ? (
          <section aria-label="Properties">
            <h3 className={styles.sectionTitle}>Properties</h3>
            <KeyValueList
              items={props.map(([k, v]) => ({
                key: k,
                label: humanize(k),
                value: Array.isArray(v) ? v.map(String).join(', ') || null : countText(v),
              }))}
            />
          </section>
        ) : null}
        <Neighbourhood detail={detail} />
        <EdgeList
          runId={runId}
          title="Outgoing"
          direction="out"
          edges={detail.outgoing}
          unused={unused}
        />
        <EdgeList
          runId={runId}
          title="Incoming"
          direction="in"
          edges={detail.incoming}
          unused={unused}
        />
      </CardBody>
    </Card>
  );
}

function EdgeList({
  runId,
  title,
  direction,
  edges,
  unused,
}: {
  runId: string;
  title: string;
  direction: 'out' | 'in';
  edges: GraphEdge[];
  unused: boolean;
}) {
  return (
    <section aria-label={`${title} edges`}>
      <h3 className={styles.sectionTitle}>
        {title} ({edges.length})
      </h3>
      {edges.length === 0 ? (
        <p className={`${s.muted} ${s.small}`}>None.</p>
      ) : (
        <ul className={styles.plainList}>
          {groupEdges(edges).map(([type, list]) => (
            <li key={type}>
              <span className={s.small}>
                <strong>{edgeLabel(type, direction)}</strong> ({list.length})
              </span>
              <ul className={styles.edgeGroup}>
                {list.map((e, i) => (
                  <li key={`${e.node_id}:${String(i)}`} className={s.row}>
                    <NodeLink
                      runId={runId}
                      unused={unused}
                      node={{
                        id: e.node_id,
                        kind: e.node_kind ?? 'unknown',
                        element: e.element ?? e.node_id,
                      }}
                    />
                    {e.props && Object.keys(e.props).length > 0 ? (
                      <span className={`${s.muted} ${s.xs}`}>
                        {Object.entries(e.props)
                          .map(([k, v]) => `${humanize(k)}: ${countText(v)}`)
                          .join(' · ')}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const MAX_DRAWN = 12;

/** A small picture of the node and its nearest neighbours; the edge lists are the text equivalent. */
function Neighbourhood({ detail }: { detail: GraphNodeDetail }) {
  const all = [
    ...detail.outgoing.map((e) => ({ ...e, dir: 'out' as const })),
    ...detail.incoming.map((e) => ({ ...e, dir: 'in' as const })),
  ];
  if (all.length === 0) return null;
  const drawn = all.slice(0, MAX_DRAWN);
  const cx = 180;
  const cy = 120;
  const r = 90;
  const label = (t: string) => (t.length > 22 ? `${t.slice(0, 21)}…` : t);
  return (
    <figure>
      <svg
        viewBox="0 0 360 240"
        className={styles.neighbourhood}
        role="img"
        aria-labelledby="kg-pic-title"
      >
        <title id="kg-pic-title">
          {`${detail.node.element} with ${String(all.length)} connected node${all.length === 1 ? '' : 's'}${
            all.length > MAX_DRAWN ? `, the first ${String(MAX_DRAWN)} drawn` : ''
          }. The edges are listed in full below.`}
        </title>
        {drawn.map((e, i) => {
          const a = (2 * Math.PI * i) / drawn.length - Math.PI / 2;
          const x = cx + r * Math.cos(a);
          const y = cy + r * 0.85 * Math.sin(a);
          return (
            <g key={`${e.dir}:${e.node_id}:${String(i)}`}>
              <line
                x1={cx}
                y1={cy}
                x2={x}
                y2={y}
                strokeDasharray={e.dir === 'in' ? '4 3' : undefined}
              />
              <circle cx={x} cy={y} r={5} className={styles.nodeOther} />
              <text x={x} y={y - 8} textAnchor="middle">
                {label(e.element ?? e.node_id)}
              </text>
            </g>
          );
        })}
        <circle cx={cx} cy={cy} r={9} className={styles.nodeCentre} />
        <text x={cx} y={cy + 22} textAnchor="middle" fontWeight={600}>
          {label(detail.node.element)}
        </text>
      </svg>
      <figcaption className={`${s.muted} ${s.xs}`}>
        Solid lines are outgoing edges, dashed lines incoming.
      </figcaption>
    </figure>
  );
}
