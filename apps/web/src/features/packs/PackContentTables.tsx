import { ShieldCheck } from 'lucide-react';
import { useMemo } from 'react';
import { useControlTypes } from '@/api/packs';
import type { PackControl, PackRule, PackSetting, PackSource } from '@/api/types';
import {
  Badge,
  Card,
  CardBody,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Mono,
  StatusPill,
} from '@/ui';
import s from '../shared.module.css';
import { formatSettingValue, placementLabel, strictnessWords } from './model';

export function Sources({ sources }: { sources: readonly PackSource[] | undefined }) {
  if (!sources || sources.length === 0) return <span className={s.muted}>—</span>;
  return (
    <span className={s.cellStack}>
      {sources.map((src, i) =>
        src.url ? (
          <a key={i} href={src.url} target="_blank" rel="noopener noreferrer" className={s.small}>
            {src.reference}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : (
          <span key={i} className={s.small}>
            {src.reference}
          </span>
        ),
      )}
    </span>
  );
}

const wrap = { whiteSpace: 'normal' } as const;

export function ControlsTable({ controls }: { controls: readonly PackControl[] }) {
  const types = useControlTypes();
  const placement = useMemo(
    () => new Map((types.data ?? []).map((t) => [t.type, t])),
    [types.data],
  );
  const columns = useMemo(() => {
    const col = createDataTableColumns<PackControl>();
    return col.columns([
      col.accessor('id', {
        header: 'Control',
        size: 240,
        cell: (info) => (
          <span className={s.cellStack} style={wrap}>
            <Mono className={s.xs}>{info.getValue()}</Mono>
            <span className={s.cellPrimary}>{info.row.original.title}</span>
            <span className={s.badges}>
              {info.row.original.compliance_critical ? (
                <Badge tone="danger">Compliance-critical</Badge>
              ) : null}
              {info.row.original.two_person_approval ? (
                <Badge tone="warning">Two-person approval</Badge>
              ) : null}
            </span>
          </span>
        ),
      }),
      col.accessor('type', {
        header: 'Type and placement',
        size: 200,
        cell: (info) => {
          const p = placement.get(info.getValue());
          return (
            <span className={s.cellStack} style={wrap}>
              <span>{info.getValue().replace(/_/g, ' ')}</span>
              {p ? (
                <span className={`${s.muted} ${s.small}`}>
                  {placementLabel(p.area)}: {p.detail}
                </span>
              ) : null}
              {info.row.original.gate ? (
                <span className={`${s.muted} ${s.small}`}>
                  Gate: {info.row.original.gate.replace(/_/g, ' ')}
                </span>
              ) : null}
            </span>
          );
        },
      }),
      col.accessor('rule', {
        header: 'Rule',
        size: 300,
        cell: (info) => <span style={wrap}>{info.getValue()}</span>,
      }),
      col.accessor('evidence_required', {
        header: 'Evidence required',
        size: 260,
        cell: (info) => <span style={wrap}>{info.getValue()}</span>,
      }),
      col.display({
        id: 'sources',
        header: 'Sources',
        size: 200,
        cell: (info) => <Sources sources={info.row.original.sources} />,
      }),
    ]);
  }, [placement]);

  return (
    <Card flush aria-label="Controls">
      <CardBody>
        <DataTable
          label="Controls this pack adds"
          data={controls}
          columns={columns}
          getRowId={(c) => c.id}
          empty={<EmptyState compact icon={<ShieldCheck />} title="This pack adds no controls" />}
        />
      </CardBody>
    </Card>
  );
}

export function RulesTable({ rules }: { rules: readonly PackRule[] }) {
  const columns = useMemo(() => {
    const col = createDataTableColumns<PackRule>();
    return col.columns([
      col.accessor('id', { header: 'Rule', size: 160, meta: { mono: true } }),
      col.accessor('statement', {
        header: 'Statement',
        size: 380,
        cell: (info) => <span style={wrap}>{info.getValue()}</span>,
      }),
      col.accessor((r) => r.severity ?? 'blocking', {
        id: 'severity',
        header: 'Severity',
        size: 110,
        cell: (info) => (
          <StatusPill tone={info.getValue() === 'blocking' ? 'danger' : 'warning'}>
            {info.getValue() === 'blocking' ? 'Blocking' : 'Warning'}
          </StatusPill>
        ),
      }),
      col.accessor((r) => (r.applies_to ?? []).join(', '), {
        id: 'applies',
        header: 'Applies to',
        size: 200,
        cell: (info) => <span style={wrap}>{info.getValue() || '—'}</span>,
      }),
      col.display({
        id: 'sources',
        header: 'Sources',
        size: 200,
        cell: (info) => <Sources sources={info.row.original.sources} />,
      }),
    ]);
  }, []);
  return (
    <Card flush aria-label="Rules">
      <CardBody>
        <DataTable
          label="Rules this pack adds"
          data={rules}
          columns={columns}
          getRowId={(r) => r.id}
        />
      </CardBody>
    </Card>
  );
}

export function SettingsTable({ settings }: { settings: readonly PackSetting[] }) {
  const columns = useMemo(() => {
    const col = createDataTableColumns<PackSetting>();
    return col.columns([
      col.accessor('key', {
        header: 'Setting',
        size: 260,
        cell: (info) => (
          <span className={s.cellStack} style={wrap}>
            <Mono className={s.small}>{info.getValue()}</Mono>
            {info.row.original.description ? (
              <span className={`${s.muted} ${s.small}`}>{info.row.original.description}</span>
            ) : null}
          </span>
        ),
      }),
      col.accessor((r) => String(r.value), {
        id: 'value',
        header: 'Value',
        size: 140,
        cell: (info) => formatSettingValue(info.row.original.value, info.row.original.unit),
      }),
      col.accessor('stricter', {
        header: 'Strictness',
        size: 220,
        cell: (info) => <span style={wrap}>{strictnessWords(info.getValue())}</span>,
      }),
      col.display({
        id: 'sources',
        header: 'Sources',
        size: 200,
        cell: (info) => <Sources sources={info.row.original.sources} />,
      }),
    ]);
  }, []);
  return (
    <Card flush aria-label="Settings">
      <CardBody>
        <DataTable
          label="Settings this pack sets"
          data={settings}
          columns={columns}
          getRowId={(r) => r.key}
        />
      </CardBody>
      <p className={s.footerNote}>
        Settings can conflict with the same setting in another pack. A conflict is never resolved
        automatically: a person decides it in the project, with a reason.
      </p>
    </Card>
  );
}
