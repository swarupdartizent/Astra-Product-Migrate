import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSetSecurity } from '@/api/design';
import { ACCESS_LEVELS, type AccessLevel, type DesignItemDetail } from '@/api/design-types';
import type { Project } from '@/api/types';
import { FormError } from '@/app/FormError';
import { Badge, Button, Callout, Checkbox, Field, KeyValueList, Select, toast } from '@/ui';
import s from '../shared.module.css';
import styles from './Design.module.css';
import {
  ACCESS_LABELS,
  bulkSet,
  changedEntries,
  missingOf,
  objectParts,
  pretty,
  str,
} from './model';

/**
 * A security profile's access matrix: every new page and report × none / view / edit / full.
 * Changes collect here and are saved together; approval waits until every object has an
 * explicit, saved decision.
 */
export function SecurityBody({
  project,
  item: it,
  onUnsaved,
}: {
  project: Project;
  item: DesignItemDetail;
  onUnsaved: (why: string | null) => void;
}) {
  const save = useSetSecurity(project.id);
  const saved = it.entries ?? {};
  const objects = Object.keys(saved).sort();
  const [draft, setDraft] = useState<Record<string, AccessLevel | null>>(saved);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkAccess, setBulkAccess] = useState<AccessLevel>('view');
  const [announce, setAnnounce] = useState('');
  const changes = changedEntries(saved, draft);
  const dirty = Object.keys(changes).length > 0;
  const missing = missingOf(draft);
  const decided = it.status === 'approved' || it.status === 'rejected';
  const why = !it.can_decide
    ? (it.cannot_decide_reason ?? 'You cannot change this profile.')
    : decided
      ? `The profile is ${it.status}; a new design run reopens it if objects change.`
      : null;
  useEffect(() => {
    onUnsaved(dirty && !why ? 'Save the access decisions first: there are unsaved changes.' : null);
  }, [dirty, why, onUnsaved]);
  useEffect(() => () => onUnsaved(null), [onUnsaved]);

  const setOne = (obj: string, a: AccessLevel) => {
    setDraft((prev) => ({ ...prev, [obj]: a }));
    if (save.error) save.reset();
  };
  const applyBulk = (targets: string[], label: string) => {
    const next = bulkSet(draft, targets, bulkAccess);
    setDraft(next);
    setAnnounce(
      `${ACCESS_LABELS[bulkAccess]} set for ${String(targets.length)} ${label}. ${String(missingOf(next).length)} object(s) still have no decision.`,
    );
    if (save.error) save.reset();
  };
  const allPicked = objects.length > 0 && objects.every((o) => picked.has(o));
  return (
    <>
      <KeyValueList
        items={[
          { key: 'p', label: 'Source profile', value: str(it.source.profile) },
          { key: 'o', label: 'New objects', value: objects.length.toLocaleString() },
          {
            key: 'm',
            label: 'Without an access decision',
            value: (
              <Badge tone={missing.length ? 'warning' : 'success'}>
                {missing.length.toLocaleString()} of {objects.length.toLocaleString()}
              </Badge>
            ),
          },
        ]}
      />
      {it.source.rights ? (
        <details>
          <summary className={s.small}>The source profile’s rights</summary>
          <pre className="plain-text">{pretty(it.source.rights)}</pre>
        </details>
      ) : null}
      <section className={styles.section} aria-labelledby={`matrix-${it.key}`}>
        <h3 id={`matrix-${it.key}`} className={styles.sectionTitle}>
          Access to new objects
        </h3>
        {objects.length === 0 ? (
          <p className={s.muted}>The design has no new pages or reports yet.</p>
        ) : (
          <>
            <div className={s.row} role="group" aria-label="Set access for several objects">
              <Field label="Access to set">
                <Select
                  size="sm"
                  options={ACCESS_LEVELS.map((a) => ({ value: a, label: ACCESS_LABELS[a] }))}
                  value={bulkAccess}
                  disabled={!!why}
                  onValueChange={(v) => setBulkAccess(v as AccessLevel)}
                />
              </Field>
              <Button
                size="sm"
                disabled={!!why || picked.size === 0}
                onClick={() => applyBulk([...picked], 'selected object(s)')}
              >
                Set selected ({picked.size})
              </Button>
              <Button
                size="sm"
                disabled={!!why || missing.length === 0}
                onClick={() => applyBulk(missing, 'object(s) without a decision')}
              >
                Set every undecided ({missing.length})
              </Button>
            </div>
            <span className="sr-only" role="status" aria-live="polite">
              {announce}
            </span>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className="sr-only">
                  Access of profile {str(it.source.profile)} to each new object
                </caption>
                <thead>
                  <tr>
                    <th scope="col">
                      <Checkbox
                        aria-label="Select every object"
                        checked={allPicked ? true : picked.size > 0 ? 'indeterminate' : false}
                        disabled={!!why}
                        onCheckedChange={(v) =>
                          setPicked(v === true ? new Set(objects) : new Set())
                        }
                      />
                    </th>
                    <th scope="col">Object</th>
                    {ACCESS_LEVELS.map((a) => (
                      <th key={a} scope="col" className={styles.center}>
                        {ACCESS_LABELS[a]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {objects.map((obj) => {
                    const { kind, name } = objectParts(obj);
                    const current = draft[obj] ?? null;
                    const changed = obj in changes;
                    return (
                      <tr key={obj} className={styles.matrixRow} data-missing={current === null}>
                        <td>
                          <Checkbox
                            aria-label={`Select ${kind.toLowerCase()} ${name}`}
                            checked={picked.has(obj)}
                            disabled={!!why}
                            onCheckedChange={(v) =>
                              setPicked((prev) => {
                                const next = new Set(prev);
                                if (v === true) next.add(obj);
                                else next.delete(obj);
                                return next;
                              })
                            }
                          />
                        </td>
                        <th scope="row">
                          <span className={s.cellStack}>
                            <span>{name}</span>
                            <span className={`${s.muted} ${s.xs}`}>
                              {kind}
                              {current === null ? ' · no decision' : ''}
                              {changed ? ' · unsaved' : ''}
                            </span>
                          </span>
                        </th>
                        {ACCESS_LEVELS.map((a) => (
                          <td key={a} className={styles.center}>
                            <input
                              type="radio"
                              className={styles.radio}
                              name={`access:${it.key}:${obj}`}
                              value={a}
                              checked={current === a}
                              disabled={!!why}
                              aria-label={`${ACCESS_LABELS[a]} access to ${kind.toLowerCase()} ${name}`}
                              onChange={() => setOne(obj, a)}
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className={s.row}>
          <Button
            variant="primary"
            leadingIcon={<Save aria-hidden="true" />}
            disabled={!!why || !dirty}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { key: it.key, entries: changes },
                {
                  onSuccess: () => {
                    toast.success(
                      `${String(Object.keys(changes).length)} access decision(s) saved`,
                    );
                    setPicked(new Set());
                  },
                },
              )
            }
          >
            Save access decisions
          </Button>
          {dirty && !why ? (
            <Badge tone="warning">{Object.keys(changes).length} unsaved change(s)</Badge>
          ) : null}
          {why ? <span className={`${s.muted} ${s.small}`}>{why}</span> : null}
        </div>
        {!why && missing.length > 0 ? (
          <Callout tone="warning">
            {missing.length} object(s) have no access decision. The profile is approved only when
            every object has one; “None” is a decision.
          </Callout>
        ) : null}
        <FormError error={save.error} />
      </section>
    </>
  );
}
