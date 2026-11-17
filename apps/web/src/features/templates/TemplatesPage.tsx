import { FileCode, Plus } from 'lucide-react';
import { useState } from 'react';
import { useCreateTemplate, useTemplates } from '@/api/blueprints';
import type { BlueprintTemplate } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { usePermissions } from '@/app/permissions';
import { hasErrors, mergeFieldErrors, type FieldErrors } from '@/lib/forms';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Button,
  Card,
  CardBody,
  CodeBlock,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Field,
  Input,
  Mono,
  PageHeader,
  Sheet,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';

const col = createDataTableColumns<BlueprintTemplate>();
const columns = col.columns([
  col.accessor('title', {
    header: 'Template',
    size: 280,
    cell: (info) => (
      <span className={s.cellStack}>
        <span className={s.cellPrimary}>{info.getValue()}</span>
        <Mono className={`${s.muted} ${s.xs}`}>{info.row.original.name}</Mono>
      </span>
    ),
  }),
  col.accessor('description', {
    header: 'Description',
    size: 420,
    cell: (info) => (
      <span style={{ whiteSpace: 'normal' }}>
        {info.getValue() || <span className={s.muted}>—</span>}
      </span>
    ),
  }),
  col.accessor('created_at', {
    header: 'Created',
    size: 180,
    cell: (info) => (
      <span className={s.cellStack}>
        <Timestamp value={info.getValue()} />
        <span className={`${s.muted} ${s.small}`}>{info.row.original.created_by}</span>
      </span>
    ),
  }),
]);

export const TEMPLATE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function TemplatesPage() {
  useDocumentTitle('Blueprint templates');
  const templates = useTemplates();
  const { can } = usePermissions();
  const [viewing, setViewing] = useState<BlueprintTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const newButton = can('template:manage') ? (
    <Button
      variant="primary"
      leadingIcon={<Plus aria-hidden="true" />}
      onClick={() => setCreating(true)}
    >
      New template
    </Button>
  ) : null;

  return (
    <>
      <PageHeader
        title="Blueprint templates"
        description="Starting points for new projects. A project created from a template gets the template's blueprint as version 1, which still needs approval."
        actions={newButton}
      />
      <Card flush aria-label="Templates">
        <CardBody>
          {templates.isError ? (
            <ApiErrorView
              error={templates.error}
              title="Could not load templates"
              onRetry={() => void templates.refetch()}
              compact
            />
          ) : (
            <DataTable
              label="Blueprint templates"
              data={templates.data}
              columns={columns}
              getRowId={(t) => t.id}
              loading={templates.isPending}
              onRowClick={setViewing}
              initialSorting={[{ id: 'title', desc: false }]}
              empty={
                <EmptyState
                  compact
                  icon={<FileCode />}
                  title="No templates yet"
                  body="Projects start from an empty blueprint until a template exists."
                  action={newButton}
                />
              }
            />
          )}
        </CardBody>
      </Card>
      {viewing ? (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) setViewing(null);
          }}
          title={viewing.title}
          description={viewing.description || undefined}
          size="lg"
        >
          <CodeBlock label={`${viewing.name}.yaml`} code={viewing.yaml_text} maxHeight="70vh" />
        </Sheet>
      ) : null}
      {creating ? <CreateTemplateDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}

interface TemplateForm {
  name: string;
  title: string;
  description: string;
  yaml_text: string;
}

function CreateTemplateDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateTemplate();
  const [form, setForm] = useState<TemplateForm>({
    name: '',
    title: '',
    description: '',
    yaml_text: '',
  });
  const [submitted, setSubmitted] = useState(false);
  const clientErrors: FieldErrors<keyof TemplateForm> = {};
  if (form.name.length < 3 || form.name.length > 100 || !TEMPLATE_NAME_PATTERN.test(form.name)) {
    clientErrors.name = 'Use 3–100 characters: lowercase letters, digits and hyphens.';
  }
  if (form.title.trim().length < 3) clientErrors.title = 'Use at least 3 characters.';
  if (form.yaml_text.trim().length < 10) clientErrors.yaml_text = 'Paste the blueprint YAML.';
  const errors = mergeFieldErrors(clientErrors, create.error, submitted);
  const set = (key: keyof TemplateForm, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (create.error) create.reset();
  };

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="New blueprint template"
      description="The YAML must parse as a blueprint mapping. It is validated against packs only when a project uses it."
      submitLabel="Create template"
      size="lg"
      pending={create.isPending}
      error={create.error}
      fields={['name', 'title', 'description', 'yaml_text']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        create.mutate(
          {
            name: form.name,
            title: form.title.trim(),
            description: form.description.trim(),
            yaml_text: form.yaml_text,
          },
          {
            onSuccess: (t) => {
              toast.success(`Template ${t.title} created`);
              onClose();
            },
          },
        );
      }}
    >
      <div className={s.grid2}>
        <Field label="Title" error={errors.title} required>
          <Input
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            maxLength={200}
          />
        </Field>
        <Field
          label="Name"
          help="Lowercase letters, digits and hyphens."
          error={errors.name}
          required
        >
          <Input
            value={form.name}
            onChange={(e) => set('name', e.target.value.toLowerCase())}
            mono
            spellCheck={false}
            maxLength={100}
          />
        </Field>
      </div>
      <Field label="Description" error={errors.description}>
        <Textarea
          rows={2}
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
        />
      </Field>
      <Field label="Blueprint YAML" error={errors.yaml_text} required>
        <Textarea
          rows={14}
          mono
          spellCheck={false}
          value={form.yaml_text}
          onChange={(e) => set('yaml_text', e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}
