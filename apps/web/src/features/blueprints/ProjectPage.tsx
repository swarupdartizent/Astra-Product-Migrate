import { useNavigate } from '@tanstack/react-router';
import { useProject, useVersion } from '@/api/blueprints';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { PageHeader, Skeleton, Tab, TabPanel, Tabs, TabsList } from '@/ui';
import s from '../shared.module.css';
import { BlueprintEditor } from './BlueprintEditor';
import { CompareTab } from './CompareTab';
import { DecisionsTab } from './DecisionsTab';
import { PlanningGatePill } from './PlanningGatePill';
import { PROJECT_TABS, type ProjectTab } from './tabs';
import { VersionsTab } from './VersionsTab';

export interface ProjectPageProps {
  projectId: string;
  tab: ProjectTab;
  version: number | null;
}

export function ProjectPage({ projectId, tab, version }: ProjectPageProps) {
  const project = useProject(projectId);
  useDocumentTitle(project.data ? project.data.name : 'Project');

  if (project.isPending) {
    return (
      <div aria-busy="true">
        <span className="sr-only">Loading project…</span>
        <PageHeader
          breadcrumbs={[{ label: 'Tenants', to: '/tenants' }, { label: 'Project' }]}
          title={<Skeleton width="16rem" height="1.75rem" />}
        />
        <Skeleton height="16rem" />
      </div>
    );
  }
  if (project.isError) {
    return (
      <>
        <PageHeader
          breadcrumbs={[{ label: 'Tenants', to: '/tenants' }, { label: 'Project' }]}
          title="Project"
        />
        <ApiErrorView
          error={project.error}
          title="Could not load this project"
          onRetry={() => void project.refetch()}
          retrying={project.isFetching}
        />
      </>
    );
  }
  return <ProjectWorkspace project={project.data} tab={tab} version={version} />;
}

function ProjectWorkspace({
  project,
  tab,
  version,
}: {
  project: Project;
  tab: ProjectTab;
  version: number | null;
}) {
  const navigate = useNavigate();
  const latest = project.latest_version;
  const base = useVersion(project.id, latest?.number ?? null);
  const go = (next: { tab: ProjectTab; version?: number }) =>
    void navigate({
      to: '/projects/$projectId',
      params: { projectId: project.id },
      search:
        next.version !== undefined ? { tab: next.tab, version: next.version } : { tab: next.tab },
      replace: true,
    });

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: 'Tenants', to: '/tenants' },
          {
            label: project.tenant_name,
            to: '/tenants/$tenantId',
            params: { tenantId: project.tenant_id },
          },
          { label: project.name },
        ]}
        title={project.name}
        meta={<PlanningGatePill gate={project.planning_gate} />}
        description={
          <span className={s.cellStack}>
            {project.description ? <span>{project.description}</span> : null}
            <span className={s.small}>
              {project.approved_version !== null
                ? `Approved blueprint: version ${project.approved_version}. `
                : 'No approved blueprint yet. '}
              {latest ? `Latest: version ${latest.number} (${latest.status}).` : 'No versions yet.'}{' '}
              {!project.planning_gate.ready ? project.planning_gate.reason : ''}
            </span>
          </span>
        }
      />
      <Tabs
        value={PROJECT_TABS.includes(tab) ? tab : 'editor'}
        onValueChange={(v) => go({ tab: v as ProjectTab })}
      >
        <TabsList aria-label="Blueprint workspace">
          <Tab value="editor">Editor</Tab>
          <Tab value="versions">Versions</Tab>
          <Tab value="compare">Compare</Tab>
          <Tab value="decisions">Decisions</Tab>
        </TabsList>
        <TabPanel value="editor">
          {latest && base.isPending ? (
            <Skeleton height="24rem" />
          ) : latest && base.isError ? (
            <ApiErrorView
              error={base.error}
              title={`Could not load version ${latest.number}`}
              onRetry={() => void base.refetch()}
            />
          ) : (
            <BlueprintEditor
              key={latest?.number ?? 0}
              project={project}
              base={base.data ?? null}
              onSaved={(v) => go({ tab: 'versions', version: v.number })}
            />
          )}
        </TabPanel>
        <TabPanel value="versions">
          <VersionsTab
            project={project}
            selected={version}
            onSelect={(n) => go({ tab: 'versions', version: n })}
          />
        </TabPanel>
        <TabPanel value="compare">
          <CompareTab project={project} />
        </TabPanel>
        <TabPanel value="decisions">
          <DecisionsTab project={project} />
        </TabPanel>
      </Tabs>
    </>
  );
}
