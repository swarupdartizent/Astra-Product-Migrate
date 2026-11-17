import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, Layers, Package, Search, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { usePacks } from '@/api/packs';
import type { PackStatus, PackSummary, PackType } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { usePermissions } from '@/app/permissions';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Badge,
  Button,
  Card,
  CardBody,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Field,
  IconButton,
  Input,
  Mono,
  PageHeader,
  Select,
  StatusPill,
  Timestamp,
} from '@/ui';
import s from '../shared.module.css';
import { groupPacks, PACK_STATUS, PACK_TYPES, packTypeLabel, testsLabel } from './model';
import { UploadPackDialog } from './UploadPackDialog';

const ALL = '__all__';

interface Row {
  pack: PackSummary;
  /** Older versions are listed under their pack's latest version when expanded. */
  older: boolean;
  /** For latest rows: how many older versions exist. */
  olderCount: number;
}

export function PackLibraryPage() {
  useDocumentTitle('Pack library');
  const navigate = useNavigate();
  const { can } = usePermissions();
  const [type, setType] = useState<PackType | ''>('');
  const [status, setStatus] = useState<PackStatus | ''>('');
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const packs = usePacks({
    ...(type ? { type } : {}),
    ...(status ? { status } : {}),
  });

  const rows = useMemo<Row[]>(() => {
    const needle = text.trim().toLowerCase();
    const matching = (packs.data ?? []).filter(
      (p) =>
        !needle || p.name.toLowerCase().includes(needle) || p.title.toLowerCase().includes(needle),
    );
    return groupPacks(matching).flatMap((g) => [
      { pack: g.latest, older: false, olderCount: g.others.length },
      ...(expanded.has(g.name)
        ? g.others.map((p) => ({ pack: p, older: true, olderCount: 0 }))
        : []),
    ]);
  }, [packs.data, text, expanded]);

  const columns = useMemo(() => {
    const col = createDataTableColumns<Row>();
    const toggle = (name: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
    return col.columns([
      col.display({
        id: 'pack',
        header: 'Pack',
        size: 300,
        enableSorting: false,
        cell: ({ row }) => {
          const { pack, older, olderCount } = row.original;
          const open = expanded.has(pack.name);
          return (
            <span
              className={s.row}
              style={{ flexWrap: 'nowrap', paddingLeft: older ? 'var(--space-6)' : 0 }}
            >
              {!older && olderCount > 0 ? (
                <IconButton
                  size="sm"
                  label={`${open ? 'Hide' : 'Show'} ${olderCount} older version${olderCount === 1 ? '' : 's'} of ${pack.name}`}
                  aria-expanded={open}
                  icon={
                    open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle(pack.name);
                  }}
                />
              ) : !older ? (
                <span style={{ width: 'var(--control-h-sm)', flexShrink: 0 }} aria-hidden="true" />
              ) : null}
              <span className={s.cellStack}>
                <Link
                  to="/packs/$name/$version"
                  params={{ name: pack.name, version: pack.version }}
                  className={s.cellLink}
                  onClick={(event) => event.stopPropagation()}
                >
                  {older ? `${pack.name} ${pack.version}` : pack.title}
                </Link>
                {older ? (
                  <span className={`${s.muted} ${s.xs}`}>Older version</span>
                ) : (
                  <Mono className={`${s.muted} ${s.xs}`}>{pack.name}</Mono>
                )}
              </span>
            </span>
          );
        },
      }),
      col.display({
        id: 'type',
        header: 'Type',
        size: 150,
        enableSorting: false,
        cell: ({ row }) => <Badge>{packTypeLabel(row.original.pack.type)}</Badge>,
      }),
      col.display({
        id: 'version',
        header: 'Version',
        size: 100,
        enableSorting: false,
        cell: ({ row }) => <Mono>{row.original.pack.version}</Mono>,
      }),
      col.display({
        id: 'status',
        header: 'Status',
        size: 120,
        enableSorting: false,
        cell: ({ row }) => {
          const st = PACK_STATUS[row.original.pack.status];
          return <StatusPill tone={st.tone}>{st.label}</StatusPill>;
        },
      }),
      col.display({
        id: 'tests',
        header: 'Tests',
        size: 100,
        enableSorting: false,
        cell: ({ row }) => {
          const t = testsLabel(row.original.pack.tests_passed);
          return <StatusPill tone={t.tone}>{t.label}</StatusPill>;
        },
      }),
      col.display({
        id: 'reviewed',
        header: 'Reviewed by',
        size: 160,
        enableSorting: false,
        cell: ({ row }) => row.original.pack.reviewed_by_name ?? <span className={s.muted}>—</span>,
      }),
      col.display({
        id: 'published',
        header: 'Published',
        size: 120,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.pack.published_at ? (
            <Timestamp value={row.original.pack.published_at} />
          ) : (
            <span className={s.muted}>Not yet</span>
          ),
      }),
    ]);
  }, [expanded]);

  const filtered = Boolean(type || status || text.trim());
  const uploadButton = can('pack:publish') ? (
    <Button
      variant="primary"
      leadingIcon={<Upload aria-hidden="true" />}
      onClick={() => setUploading(true)}
    >
      Upload pack
    </Button>
  ) : null;

  return (
    <>
      <PageHeader
        title="Pack library"
        description="Versioned packs that configure migrations: adapters for source and target products, domain knowledge, compliance controls, patterns and agentification. Published versions never change."
        actions={
          <div className={s.row}>
            <Button asChild leadingIcon={<Layers aria-hidden="true" />}>
              <Link to="/packs/compose">Composition preview</Link>
            </Button>
            {uploadButton}
          </div>
        }
      />
      <Card flush aria-label="Packs">
        <div className={s.toolbar}>
          <div className={s.filters}>
            <Field label="Search">
              <Input
                size="sm"
                type="search"
                placeholder="Name or title"
                value={text}
                onChange={(e) => setText(e.target.value)}
                startAdornment={<Search />}
              />
            </Field>
            <Field label="Type">
              <Select
                size="sm"
                options={[{ value: ALL, label: 'All types' }, ...PACK_TYPES]}
                value={type || ALL}
                onValueChange={(v) => setType(v === ALL ? '' : (v as PackType))}
              />
            </Field>
            <Field label="Status">
              <Select
                size="sm"
                options={[
                  { value: ALL, label: 'Any status' },
                  ...(['draft', 'published', 'deprecated'] as const).map((v) => ({
                    value: v,
                    label: PACK_STATUS[v].label,
                  })),
                ]}
                value={status || ALL}
                onValueChange={(v) => setStatus(v === ALL ? '' : (v as PackStatus))}
              />
            </Field>
          </div>
          {filtered ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setType('');
                setStatus('');
                setText('');
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
        <CardBody>
          {packs.isError ? (
            <ApiErrorView
              error={packs.error}
              title="Could not load packs"
              onRetry={() => void packs.refetch()}
              retrying={packs.isFetching}
              compact
            />
          ) : (
            <DataTable
              label="Packs, latest version of each"
              data={packs.data ? rows : undefined}
              columns={columns}
              getRowId={(r) => `${r.pack.name}@${r.pack.version}`}
              loading={packs.isPending}
              onRowClick={(r) =>
                void navigate({
                  to: '/packs/$name/$version',
                  params: { name: r.pack.name, version: r.pack.version },
                })
              }
              empty={
                <EmptyState
                  compact
                  icon={<Package />}
                  title={filtered ? 'No packs match these filters' : 'No packs yet'}
                  body={
                    filtered
                      ? 'Clear a filter to see more.'
                      : 'Upload a pack folder with a pack.yaml manifest to add the first one.'
                  }
                  action={filtered ? null : uploadButton}
                />
              }
            />
          )}
        </CardBody>
      </Card>
      {uploading ? <UploadPackDialog onClose={() => setUploading(false)} /> : null}
    </>
  );
}
