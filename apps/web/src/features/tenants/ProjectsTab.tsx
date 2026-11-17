import { Link, useNavigate } from '@tanstack/react-router';
import { FolderOpen, Plus } from 'lucide-react';
import { useState } from 'react';
import { useCreateProject, useTemplates, useTenantProjects } from '@/api/blueprints';
import type { Project, Tenant } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { hasErrors, mergeFieldErrors, type FieldErrors } from '@/lib/forms';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Field,
  Input,
  Select,
  StatusPill,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import { PlanningGatePill } from '../blueprints/PlanningGatePill';
import { versionStatus } from '../blueprints/model';
import { can } from './model';

const col = createDataTableColumns<Project>();
const columns = col.columns([
  col.accessor('name', {
    header: 'Project',
    size: 260,
    cell: (info) => (
      <span className={s.cellStack}>
        <Link
          to="/projects/$projectId"
          params={{ projectId: info.row.original.id }}
          className={s.cellLink}
          onClick={(e) => e.stopPropagation()}
        >
          {info.getValue()}
        </Link>
        {info.row.original.description ? (
          <span className={`${s.muted} ${s.xs}`}>{info.row.original.description}</span>
        ) : null}
      </span>
    ),
  }),
  col.accessor((p) => p.latest_version?.number ?? 0, {
    id: 'latest',
    header: 'Latest version',
    size: 170,
    cell: (info) => {
      const v = info.row.original.latest_version;
      if (!v) return <span className={s.muted}>None yet</span>;
      const st = versionStatus(v.status);
      return (
        <span className={s.row}>
          <span>v{v.number}</span>
          <StatusPill tone={st.tone}>{st.label}</StatusPill>
        </span>
      );
    },
  }),
  col.accessor((p) => p.approved_version ?? 0, {
    id: 'approved',
    header: 'Approved',
    size: 110,
    cell: (info) =>
      info.row.original.approved_version !== null ? (
        `v${info.row.original.approved_version}`
      ) : (
        <span className={s.muted}>None</span>
      ),
  }),
  col.accessor((p) => (p.planning_gate.ready ? 1 : 0), {
    id: 'gate',
    header: 'Planning',
    size: 210,
    cell: (info) => <PlanningGatePill gate={info.row.original.planning_gate} />,
  }),
  col.accessor('created_at', {
    header: 'Created',
    size: 130,
    cell: (info) => <Timestamp value={info.getValue()} />,
  }),
]);

export function ProjectsTab({ tenant }: { tenant: Tenant }) {
  const projects = useTenantProjects(tenant.id);
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const canCreate = can(tenant, 'project:create') && tenant.status === 'active';
  const newButton = canCreate ? (
    <Button
      size="sm"
      variant="primary"
      leadingIcon={<Plus aria-hidden="true" />}
      onClick={() => setCreating(true)}
    >
      New project
    </Button>
  ) : null;

  return (
    <Card flush aria-labelledby="projects-title">
      <CardHeader
        titleId="projects-title"
        title="Projects"
        description="Each project has a versioned blueprint. Planning starts only from an approved, valid version."
        actions={newButton}
      />
      <CardBody>
        {projects.isError ? (
          <ApiErrorView
            error={projects.error}
            title="Could not load projects"
            onRetry={() => void projects.refetch()}
            compact
          />
        ) : (
          <DataTable
            label="Projects"
            data={projects.data}
            columns={columns}
            getRowId={(p) => p.id}
            loading={projects.isPending}
            onRowClick={(p) =>
              void navigate({ to: '/projects/$projectId', params: { projectId: p.id } })
            }
            empty={
              <EmptyState
                compact
                icon={<FolderOpen />}
                title="No projects yet"
                body={canCreate ? 'Create a project to start its blueprint.' : undefined}
                action={newButton}
              />
            }
          />
        )}
      </CardBody>
      {creating ? <CreateProjectDialog tenant={tenant} onClose={() => setCreating(false)} /> : null}
    </Card>
  );
}

const NONE = '__none__';

function CreateProjectDialog({ tenant, onClose }: { tenant: Tenant; onClose: () => void }) {
  const navigate = useNavigate();
  const create = useCreateProject(tenant.id);
  const templates = useTemplates();
  const [form, setForm] = useState({ name: '', description: '', template: '' });
  const [submitted, setSubmitted] = useState(false);
  const clientErrors: FieldErrors<'name' | 'description' | 'template'> = {};
  const n = form.name.trim().length;
  if (n < 3 || n > 200) clientErrors.name = 'Use 3–200 characters.';
  const errors = mergeFieldErrors(clientErrors, create.error, submitted);
  const tpl = templates.data?.find((t) => t.name === form.template);

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`New project in ${tenant.name}`}
      submitLabel="Create project"
      pending={create.isPending}
      error={create.error}
      fields={['name', 'description', 'template']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        create.mutate(
          {
            name: form.name.trim(),
            description: form.description.trim(),
            template: form.template || null,
          },
          {
            onSuccess: (p) => {
              toast.success(`Project ${p.name} created`, {
                description: p.latest_version
                  ? `Version 1 copied from the template. It still needs approval.`
                  : 'Start its blueprint in the editor.',
              });
              onClose();
              void navigate({ to: '/projects/$projectId', params: { projectId: p.id } });
            },
          },
        );
      }}
    >
      <Field label="Name" error={errors.name} required>
        <Input
          value={form.name}
          onChange={(e) => {
            setForm((f) => ({ ...f, name: e.target.value }));
            if (create.error) create.reset();
          }}
          maxLength={200}
        />
      </Field>
      <Field label="Description" error={errors.description}>
        <Textarea
          rows={2}
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          maxLength={4000}
        />
      </Field>
      <Field
        label="Start from a template"
        help={
          tpl
            ? tpl.description || `The template's blueprint becomes version 1.`
            : 'Optional. Without a template the blueprint starts empty.'
        }
        error={
          errors.template ?? (templates.isError ? 'Templates could not be loaded.' : undefined)
        }
      >
        <Select
          options={[
            { value: NONE, label: 'No template' },
            ...(templates.data ?? []).map((t) => ({ value: t.name, label: t.title })),
          ]}
          value={form.template || NONE}
          onValueChange={(v) => setForm((f) => ({ ...f, template: v === NONE ? '' : v }))}
          disabled={templates.isPending}
        />
      </Field>
    </FormDialog>
  );
}
