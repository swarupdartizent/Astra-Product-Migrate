import { useNavigate } from '@tanstack/react-router';
import { useProject, useVersion } from '@/api/blueprints';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { PageHeader, Skeleton, Tab, TabPanel, Tabs, TabsList } from '@/ui';
import s from '../shared.module.css';
import { BlueprintEditor } from './BlueprintEditor';
import { ProjectAgentsTab } from '../runtime/ProjectAgentsTab';
import { ReviewWorkbenchTab } from '../review/ReviewWorkbenchTab';
import type { ReviewSearch } from '../review/model';
import type { PlanSection } from '../plan/model';
import { StageStrip } from '../runtime/StageStrip';
import { CompareTab } from './CompareTab';
import { DecisionsTab } from './DecisionsTab';
import { PlanningGatePill } from './PlanningGatePill';
import { PROJECT_TABS, type ProjectSearch, type ProjectTab } from './tabs';
import { VersionsTab } from './VersionsTab';
import { ProjectBaselineTab } from '../baselines/ProjectBaselineTab';
import { DiscoveryTab } from '../discovery/DiscoveryTab';
import { DeltaTab } from '../delta/DeltaTab';
import { ConversionTab } from '../conversion/ConversionTab';
import { ChecklistTab } from '../checklist/ChecklistTab';
import { PlanTab } from '../plan/PlanTab';

export interface ProjectPageProps {
  projectId: string;
  search: ProjectSearch;
}

export function ProjectPage({ projectId, search }: ProjectPageProps) {
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
  return <ProjectWorkspace project={project.data} search={search} />;
}

function ProjectWorkspace({ project, search }: { project: Project; search: ProjectSearch }) {
  const navigate = useNavigate();
  const tab = search.tab ?? 'editor';
  const version = search.version ?? null;
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
  const {
    tab: _tab,
    version: _version,
    section: _section,
    run: _run,
    object: _object,
    agent_run: _agentRun,
    ...reviewSearch
  } = search;
  const goReviews = (next: ReviewSearch, replace: boolean) =>
    void navigate({
      to: '/projects/$projectId',
      params: { projectId: project.id },
      search: { tab: 'reviews', ...next },
      replace,
    });
  const goPlanSection = (section: PlanSection) =>
    void navigate({
      to: '/projects/$projectId',
      params: { projectId: project.id },
      search: { tab: 'plan', section },
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
      <StageStrip project={project} />
      <Tabs
        value={PROJECT_TABS.includes(tab) ? tab : 'editor'}
        onValueChange={(v) => go({ tab: v as ProjectTab })}
      >
        <TabsList aria-label="Blueprint workspace">
          <Tab value="editor">Editor</Tab>
          <Tab value="versions">Versions</Tab>
          <Tab value="compare">Compare</Tab>
          <Tab value="decisions">Decisions</Tab>
          <Tab value="agents">Agents</Tab>
          <Tab value="reviews">Review queue</Tab>
          <Tab value="baseline">Target baseline</Tab>
          <Tab value="discovery">Discovery</Tab>
          <Tab value="delta">Version delta</Tab>
          <Tab value="conversion">Conversion</Tab>
          <Tab value="checklist">Hosting checklist</Tab>
          <Tab value="plan">Plan</Tab>
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
        <TabPanel value="agents">
          <ProjectAgentsTab
            key={search.agent_run ?? ''}
            project={project}
            initialRun={search.agent_run ?? null}
          />
        </TabPanel>
        <TabPanel value="reviews">
          <ReviewWorkbenchTab project={project} search={reviewSearch} onSearch={goReviews} />
        </TabPanel>
        <TabPanel value="baseline">
          <ProjectBaselineTab project={project} />
        </TabPanel>
        <TabPanel value="discovery">
          <DiscoveryTab project={project} />
        </TabPanel>
        <TabPanel value="delta">
          <DeltaTab key={search.run ?? ''} project={project} initialRun={search.run ?? null} />
        </TabPanel>
        <TabPanel value="conversion">
          <ConversionTab
            key={`${search.run ?? ''}:${search.object ?? ''}`}
            project={project}
            initialRun={search.run ?? null}
            initialObject={search.object ?? null}
          />
        </TabPanel>
        <TabPanel value="checklist">
          <ChecklistTab project={project} />
        </TabPanel>
        <TabPanel value="plan">
          <PlanTab
            project={project}
            section={search.section ?? 'overview'}
            onSection={goPlanSection}
          />
        </TabPanel>
      </Tabs>
    </>
  );
}
