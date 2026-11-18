import { useNavigate } from '@tanstack/react-router';
import { RequirePermission } from '@/app/RequirePermission';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { PageHeader, Tab, TabPanel, Tabs, TabsList } from '@/ui';
import { AliasesTab } from './AliasesTab';
import { CallsTab } from './CallsTab';
import { MODEL_READ_PERMISSIONS } from './model';
import { ProvidersTab } from './ProvidersTab';
import { MODEL_TABS, type ModelTab } from './tabs';
import { UsageTab } from './UsageTab';

export function ModelsPage({ tab }: { tab: ModelTab }) {
  return (
    <RequirePermission permission={MODEL_READ_PERMISSIONS}>
      <ModelsView tab={tab} />
    </RequirePermission>
  );
}

function ModelsView({ tab }: { tab: ModelTab }) {
  useDocumentTitle('Models');
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title="Models"
        description="Model providers, the aliases agents use, and what every model call cost. Agents never name a provider or model directly."
      />
      <Tabs
        value={MODEL_TABS.includes(tab) ? tab : 'providers'}
        onValueChange={(v) =>
          void navigate({ to: '/models', search: { tab: v as ModelTab }, replace: true })
        }
      >
        <TabsList aria-label="Model gateway sections">
          <Tab value="providers">Providers</Tab>
          <Tab value="aliases">Aliases</Tab>
          <Tab value="usage">Usage and cost</Tab>
          <Tab value="calls">Calls</Tab>
        </TabsList>
        <TabPanel value="providers">
          <ProvidersTab />
        </TabPanel>
        <TabPanel value="aliases">
          <AliasesTab />
        </TabPanel>
        <TabPanel value="usage">
          <UsageTab />
        </TabPanel>
        <TabPanel value="calls">
          <CallsTab />
        </TabPanel>
      </Tabs>
    </>
  );
}
