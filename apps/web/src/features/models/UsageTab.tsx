import { useState } from 'react';
import { useModelUsage } from '@/api/models';
import type { UsageGroupBy } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { localToIso } from '../audit/model';
import { Card, CardBody, Field, Input, SegmentedControl, Switch } from '@/ui';
import s from '../shared.module.css';
import { USAGE_GROUPS } from './model';
import { UsageTable } from './UsageTable';

export function UsageTab() {
  const [groupBy, setGroupBy] = useState<UsageGroupBy>('agent');
  const [since, setSince] = useState('');
  const [includeTests, setIncludeTests] = useState(true);
  const sinceIso = localToIso(since);
  const usage = useModelUsage({
    group_by: groupBy,
    include_tests: includeTests,
    ...(sinceIso ? { since: sinceIso } : {}),
  });
  const label = USAGE_GROUPS.find((g) => g.value === groupBy)?.label ?? 'Group';

  return (
    <Card flush aria-label="Model usage">
      <div className={s.toolbar}>
        <SegmentedControl
          label="Group by"
          options={USAGE_GROUPS}
          value={groupBy}
          onValueChange={setGroupBy}
          size="sm"
        />
        <div className={s.row}>
          <Field label="Since">
            <Input
              size="sm"
              type="datetime-local"
              value={since}
              onChange={(e) => setSince(e.target.value)}
            />
          </Field>
          <Field label="Include agent test runs" inline>
            <Switch checked={includeTests} onCheckedChange={setIncludeTests} />
          </Field>
        </div>
      </div>
      <CardBody>
        {usage.isError ? (
          <ApiErrorView
            error={usage.error}
            title="Could not load usage"
            compact
            onRetry={() => void usage.refetch()}
          />
        ) : (
          <div style={{ padding: 'var(--space-3) 0' }}>
            <UsageTable rows={usage.data} loading={usage.isPending} groupLabel={label} />
          </div>
        )}
      </CardBody>
    </Card>
  );
}
