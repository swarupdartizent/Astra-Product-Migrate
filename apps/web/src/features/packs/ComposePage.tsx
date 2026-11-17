import { Layers } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useComposition, usePublishedPacks } from '@/api/packs';
import { ApiErrorView } from '@/app/ApiErrorView';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { Card, CardBody, CheckboxGroup, EmptyState, PageHeader, Skeleton } from '@/ui';
import s from '../shared.module.css';
import { CompositionView } from './CompositionView';
import { PACK_TYPES, packRef } from './model';

export function ComposePage() {
  useDocumentTitle('Composition preview');
  const packs = usePublishedPacks();
  const [selected, setSelected] = useState<string[]>([]);
  const refs = useDebouncedValue(selected, 250);
  const composition = useComposition(refs);

  const byType = useMemo(
    () =>
      PACK_TYPES.map((t) => ({
        ...t,
        options: (packs.data ?? [])
          .filter((p) => p.type === t.value)
          .map((p) => ({ value: packRef(p), label: p.title, description: packRef(p) })),
      })).filter((t) => t.options.length > 0),
    [packs.data],
  );

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Pack library', to: '/packs' }, { label: 'Composition preview' }]}
        title="Composition preview"
        description="See what a set of published packs adds together: every control placed where the planner will use it, every setting, and the conflicts a person must decide. Nothing is saved."
      />
      <div className={s.stack}>
        <Card aria-label="Choose packs">
          <CardBody className={s.stack}>
            {packs.isPending ? (
              <Skeleton height="8rem" />
            ) : packs.isError ? (
              <ApiErrorView
                error={packs.error}
                title="Could not load packs"
                compact
                onRetry={() => void packs.refetch()}
              />
            ) : byType.length === 0 ? (
              <EmptyState compact icon={<Layers />} title="No published packs yet" />
            ) : (
              <div className={s.grid2}>
                {byType.map((t) => (
                  <CheckboxGroup
                    key={t.value}
                    legend={t.label}
                    options={t.options}
                    value={selected.filter((r) => t.options.some((o) => o.value === r))}
                    onValueChange={(next) =>
                      setSelected((prev) => [
                        ...prev.filter((r) => !t.options.some((o) => o.value === r)),
                        ...next,
                      ])
                    }
                    maxHeight="14rem"
                  />
                ))}
              </div>
            )}
          </CardBody>
        </Card>
        {refs.length === 0 ? (
          <EmptyState
            icon={<Layers />}
            title="Choose packs to compose"
            body="Pick at least one published pack. Pick one version of each pack."
          />
        ) : composition.isError ? (
          <ApiErrorView
            error={composition.error}
            title="These packs cannot be composed"
            onRetry={() => void composition.refetch()}
          />
        ) : composition.data ? (
          <div aria-busy={composition.isFetching || undefined}>
            <CompositionView composition={composition.data} />
          </div>
        ) : (
          <Skeleton height="16rem" />
        )}
      </div>
    </>
  );
}
