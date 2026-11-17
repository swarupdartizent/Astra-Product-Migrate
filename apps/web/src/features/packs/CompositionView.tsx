import { useMemo } from 'react';
import type { ComposedSetting, Composition } from '@/api/types';
import {
  Badge,
  Callout,
  Card,
  CardBody,
  CardHeader,
  createDataTableColumns,
  DataTable,
  Mono,
  StatusPill,
} from '@/ui';
import s from '../shared.module.css';
import { formatSettingValue, groupControlsByArea, placementLabel, strictnessWords } from './model';
import styles from './Packs.module.css';

const settingCol = createDataTableColumns<ComposedSetting>();
const settingColumns = settingCol.columns([
  settingCol.accessor('key', {
    header: 'Setting',
    size: 260,
    cell: (info) => (
      <span className={s.cellStack} style={{ whiteSpace: 'normal' }}>
        <Mono className={s.small}>{info.getValue()}</Mono>
        <span className={`${s.muted} ${s.xs}`}>{strictnessWords(info.row.original.stricter)}</span>
      </span>
    ),
  }),
  settingCol.display({
    id: 'values',
    header: 'Value per pack',
    size: 320,
    cell: (info) => (
      <span className={s.cellStack} style={{ whiteSpace: 'normal' }}>
        {info.row.original.values.map((v) => (
          <span key={v.pack} className={s.small}>
            <strong>{formatSettingValue(v.value, info.row.original.unit)}</strong>{' '}
            <span className={s.muted}>from {v.pack}</span>
          </span>
        ))}
      </span>
    ),
  }),
  settingCol.accessor('conflict', {
    header: 'Outcome',
    size: 280,
    cell: (info) => {
      const st = info.row.original;
      if (!st.conflict) {
        return <StatusPill tone="success">Agreed</StatusPill>;
      }
      return (
        <span className={s.cellStack} style={{ whiteSpace: 'normal' }}>
          <StatusPill tone="warning">Conflict</StatusPill>
          <span className={s.small}>
            {st.strictest !== null
              ? `Stricter: ${formatSettingValue(st.strictest, st.unit)}. `
              : 'No order between the values. '}
            No default is applied — a person decides in the project.
          </span>
        </span>
      );
    },
  }),
]);

export interface CompositionViewProps {
  composition: Composition;
  /** Smaller summary for side panels. */
  compact?: boolean;
}

export function CompositionView({ composition, compact = false }: CompositionViewProps) {
  const areas = useMemo(() => groupControlsByArea(composition), [composition]);
  const conflicts = composition.settings.filter((x) => x.conflict).length;

  if (compact) {
    return (
      <div className={s.stackSm}>
        <p className={s.small}>
          {composition.packs.length} pack{composition.packs.length === 1 ? '' : 's'},{' '}
          {composition.controls.length} control{composition.controls.length === 1 ? '' : 's'},{' '}
          {composition.settings.length} setting{composition.settings.length === 1 ? '' : 's'}
          {conflicts > 0 ? (
            <>
              ,{' '}
              <strong>
                {conflicts} conflict{conflicts === 1 ? '' : 's'}
              </strong>
            </>
          ) : null}
          .
        </p>
        {areas.length > 0 ? (
          <ul className={s.badges} aria-label="Controls by placement">
            {areas.map(([area, list]) => (
              <li key={area} style={{ listStyle: 'none' }}>
                <Badge>
                  {placementLabel(area)}: {list.length}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  return (
    <div className={s.stack}>
      {composition.problems.length > 0 ? (
        <Callout tone="danger" title="Requirement problems">
          <ul style={{ paddingLeft: 'var(--space-4)' }}>
            {composition.problems.map((p, i) => (
              <li key={i}>
                {p.message} <span className={s.muted}>{p.fix}</span>
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <section aria-labelledby="controls-by-area">
        <h2
          id="controls-by-area"
          className={s.cellPrimary}
          style={{ marginBottom: 'var(--space-3)' }}
        >
          Controls by placement ({composition.controls.length})
        </h2>
        {areas.length === 0 ? (
          <p className={s.muted}>These packs add no controls.</p>
        ) : (
          <div className={styles.areaGrid}>
            {areas.map(([area, list]) => (
              <Card key={area} aria-label={placementLabel(area)}>
                <CardHeader
                  title={`${placementLabel(area)} (${list.length})`}
                  description={list[0]?.placement.detail}
                />
                <CardBody>
                  <ul style={{ listStyle: 'none' }} className={s.stackSm}>
                    {list.map((c) => (
                      <li key={c.key} className={s.cellStack}>
                        <span>
                          <Mono className={s.xs}>{c.id}</Mono> {c.title}
                        </span>
                        <span className={`${s.muted} ${s.xs}`}>
                          {c.pack}
                          {c.compliance_critical ? ' · compliance-critical' : ''}
                          {c.two_person_approval ? ' · two-person approval' : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </section>

      <Card flush aria-labelledby="composed-settings">
        <CardHeader
          titleId="composed-settings"
          title={`Settings (${composition.settings.length})`}
          description={
            conflicts > 0
              ? `${conflicts} conflict${conflicts === 1 ? '' : 's'}: packs set different values. Each is decided by a person in the project, with a reason.`
              : 'No conflicts between these packs.'
          }
        />
        <CardBody>
          <DataTable
            label="Composed settings"
            data={composition.settings}
            columns={settingColumns}
            getRowId={(x) => x.key}
          />
        </CardBody>
      </Card>
    </div>
  );
}
