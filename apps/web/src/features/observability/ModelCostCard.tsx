import { useState } from 'react';
import { useModelUsage } from '@/api/models';
import { ApiErrorView } from '@/app/ApiErrorView';
import { Card, CardBody, CardHeader, SegmentedControl } from '@/ui';
import { UsageTable } from '../models/UsageTable';

type CostGroup = 'agent' | 'served_model';

const OPTIONS: readonly { value: CostGroup; label: string }[] = [
  { value: 'agent', label: 'By agent' },
  { value: 'served_model', label: 'By model' },
];

/** Model cost from recorded model calls, by agent or by the model that actually answered. */
export function ModelCostCard() {
  const [groupBy, setGroupBy] = useState<CostGroup>('agent');
  const usage = useModelUsage({ group_by: groupBy });
  return (
    <Card flush aria-labelledby="model-cost-title">
      <CardHeader
        titleId="model-cost-title"
        title={groupBy === 'agent' ? 'Model cost by agent' : 'Model cost by model'}
        description="From every recorded model call, test runs included. Costs use the provider prices configured under Models."
        actions={
          <SegmentedControl
            label="Model cost grouping"
            size="sm"
            options={OPTIONS}
            value={groupBy}
            onValueChange={setGroupBy}
          />
        }
      />
      <CardBody>
        {usage.isError ? (
          <ApiErrorView
            error={usage.error}
            title="Could not load model cost"
            compact
            onRetry={() => void usage.refetch()}
          />
        ) : (
          <div style={{ padding: 'var(--space-3) 0' }}>
            <UsageTable
              rows={usage.data}
              loading={usage.isPending}
              groupLabel={groupBy === 'agent' ? 'Agent' : 'Model'}
            />
          </div>
        )}
      </CardBody>
    </Card>
  );
}
