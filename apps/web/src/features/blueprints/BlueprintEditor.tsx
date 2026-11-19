import { FileCode, ListChecks, Save } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { convertBlueprint, useBlueprintValidation, useSaveVersion } from '@/api/blueprints';
import { isApiError } from '@/api/errors';
import type { BlueprintBody, BlueprintValidation, Project, VersionDetail } from '@/api/types';
import { FormDialog } from '@/app/FormDialog';
import { FormError } from '@/app/FormError';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Field,
  SegmentedControl,
  Skeleton,
  Spinner,
  StatusPill,
  Textarea,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import { CompositionView } from '../packs/CompositionView';
import { BlueprintForm } from './BlueprintForm';
import { emptyBlueprint, fieldId, groupIssues, pathCandidates, type Content } from './model';
import styles from './Blueprint.module.css';

type Mode = 'form' | 'yaml';

export interface BlueprintEditorProps {
  project: Project;
  /** The version the draft starts from; null when the project has none yet. */
  base: VersionDetail | null;
  onSaved: (version: VersionDetail) => void;
}

/**
 * Two synchronised views of one draft. The form edits `content`; the file view edits YAML text.
 * Switching converts through the API so both always agree with how the server reads them.
 */
export function BlueprintEditor({ project, base, onSaved }: BlueprintEditorProps) {
  const canEdit = project.permissions.includes('blueprint:edit');
  const initialContent = useMemo<Content>(
    () => base?.content ?? emptyBlueprint(project.name),
    [base, project.name],
  );
  const [content, setContent] = useState<Content>(initialContent);
  const [yamlText, setYamlText] = useState<string>(base?.yaml_text ?? '');
  const [mode, setMode] = useState<Mode>('form');
  const [formRevision, setFormRevision] = useState(0);
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  // Empty fields show their inline error only once the user edits them, opens them from the problem list, or saves.
  const [revealed, setRevealed] = useState<ReadonlySet<string> | 'all'>(() => new Set());
  const yamlRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const dirty =
    mode === 'form'
      ? JSON.stringify(content) !== JSON.stringify(initialContent)
      : yamlText !== (base?.yaml_text ?? '');

  const body = useMemo<BlueprintBody>(
    () => (mode === 'form' ? { content } : { yaml_text: yamlText }),
    [mode, content, yamlText],
  );
  const debouncedBody = useDebouncedValue(body, 600);
  const validation = useBlueprintValidation(project.id, debouncedBody);
  const checking = validation.isFetching || debouncedBody !== body;

  async function switchMode(next: Mode) {
    if (next === mode || converting) return;
    setConverting(true);
    setConvertError(null);
    try {
      if (next === 'yaml') {
        const out = await convertBlueprint({ content });
        setYamlText(out.yaml_text);
      } else {
        const out = await convertBlueprint({ yaml_text: yamlText });
        setContent(out.content);
        setFormRevision((r) => r + 1);
      }
      setMode(next);
    } catch (e) {
      // Invalid YAML: stay in the file view and show where the problem is.
      setConvertError(e);
    } finally {
      setConverting(false);
    }
  }

  function focusIssue(path: string) {
    if (mode === 'yaml' || path === '(file)') {
      yamlRef.current?.focus();
      return;
    }
    setRevealed((r) => (r === 'all' ? r : new Set(r).add(path)));
    for (const candidate of pathCandidates(path)) {
      const el = document.getElementById(fieldId(candidate));
      if (el) {
        const details = el.closest('details');
        if (details && !details.open) details.open = true;
        if (el instanceof HTMLDetailsElement) el.open = true;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        (el instanceof HTMLDetailsElement ? el.querySelector<HTMLElement>('summary') : el)?.focus({
          preventScroll: true,
        });
        return;
      }
    }
  }

  const lineCount = Math.max(1, yamlText.split('\n').length);

  return (
    <div className={styles.workspace}>
      <div>
        <div className={styles.toolbar}>
          <SegmentedControl
            label="Editor view"
            options={[
              { value: 'form', label: 'Form' },
              { value: 'yaml', label: 'YAML file' },
            ]}
            value={mode}
            onValueChange={(v) => void switchMode(v)}
          />
          <div className={s.row}>
            {converting ? (
              <span className={`${s.row} ${s.muted} ${s.small}`} role="status">
                <Spinner size={14} /> Converting…
              </span>
            ) : null}
            {dirty ? <Badge tone="warning">Unsaved changes</Badge> : null}
            {base ? (
              <span className={`${s.muted} ${s.small}`}>Starting from version {base.number}</span>
            ) : (
              <span className={`${s.muted} ${s.small}`}>New blueprint</span>
            )}
            {canEdit ? (
              <Button
                variant="primary"
                leadingIcon={<Save aria-hidden="true" />}
                disabled={!dirty && base !== null}
                onClick={() => {
                  setRevealed('all');
                  setSaving(true);
                }}
              >
                Save version
              </Button>
            ) : null}
          </div>
        </div>
        {!canEdit ? (
          <div style={{ marginBottom: 'var(--space-4)' }}>
            <Callout tone="info" title="Read only">
              You need permission to edit this project&apos;s blueprint to change it.
            </Callout>
          </div>
        ) : null}
        {convertError ? (
          <div style={{ marginBottom: 'var(--space-4)' }}>
            <Callout tone="danger" title="The file cannot be shown as a form yet" live>
              {isApiError(convertError)
                ? (convertError.detail ?? convertError.title)
                : 'The conversion failed.'}{' '}
              Fix the YAML, then switch again.
            </Callout>
          </div>
        ) : null}
        {mode === 'form' ? (
          <BlueprintForm
            key={formRevision}
            content={content}
            onChange={setContent}
            tenantId={project.tenant_id}
            validation={validation.data}
            revealed={revealed}
            readOnly={!canEdit}
          />
        ) : (
          <Field
            label="Blueprint file (YAML)"
            help="Edits here and in the form are the same blueprint. Switching back to the form checks the YAML first."
            controlId="bp-yaml"
          >
            <div className={styles.yamlWrap}>
              <div ref={gutterRef} className={styles.gutter} aria-hidden="true">
                {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
              </div>
              <Textarea
                ref={yamlRef}
                className={styles.yaml}
                value={yamlText}
                onChange={(e) => {
                  setYamlText(e.target.value);
                  setConvertError(null);
                }}
                onScroll={(e) => {
                  if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
                }}
                readOnly={!canEdit}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                wrap="off"
              />
            </div>
          </Field>
        )}
      </div>

      <aside className={styles.side} aria-label="Validation">
        <ValidationPanel
          validation={validation.data}
          error={validation.error}
          checking={checking}
          onIssue={focusIssue}
        />
      </aside>

      {saving ? (
        <SaveDialog
          project={project}
          body={body}
          blocking={validation.data?.blocking ?? 0}
          onClose={() => setSaving(false)}
          onSaved={(v) => {
            setSaving(false);
            onSaved(v);
          }}
        />
      ) : null}
    </div>
  );
}

function ValidationPanel({
  validation,
  error,
  checking,
  onIssue,
}: {
  validation: BlueprintValidation | undefined;
  error: unknown;
  checking: boolean;
  onIssue: (path: string) => void;
}) {
  const { blocking, warnings } = groupIssues(validation);
  return (
    <>
      <Card aria-labelledby="validation-title" flush>
        <CardHeader
          titleId="validation-title"
          title="Validation"
          description="Checked as you edit. Nothing is saved."
          actions={checking ? <Spinner label="Checking" size={14} /> : null}
        />
        <CardBody>
          {error && !validation ? (
            <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
              <FormError error={error} />
            </div>
          ) : !validation ? (
            <div style={{ padding: 'var(--space-4)' }}>
              <Skeleton height="4rem" />
            </div>
          ) : (
            <>
              <div
                className={styles.counts}
                style={{ padding: 'var(--space-3) var(--space-4)' }}
                role="status"
              >
                {validation.ok ? (
                  <StatusPill tone="success">No blocking problems</StatusPill>
                ) : (
                  <StatusPill tone="danger">
                    {validation.blocking} blocking problem{validation.blocking === 1 ? '' : 's'}
                  </StatusPill>
                )}
                {validation.warnings > 0 ? (
                  <StatusPill tone="warning">
                    {validation.warnings} warning{validation.warnings === 1 ? '' : 's'}
                  </StatusPill>
                ) : null}
              </div>
              {blocking.length + warnings.length > 0 ? (
                <ul className={styles.issues} aria-label="Problems">
                  {[...blocking, ...warnings].map((issue, i) => (
                    <li key={`${issue.path}-${issue.code}-${i}`} className={styles.issue}>
                      <button
                        type="button"
                        className={styles.issueButton}
                        onClick={() => onIssue(issue.path)}
                      >
                        <span className={s.row}>
                          <StatusPill tone={issue.severity === 'blocking' ? 'danger' : 'warning'}>
                            {issue.severity === 'blocking' ? 'Blocking' : 'Warning'}
                          </StatusPill>
                          <span className={styles.issuePath}>{issue.path}</span>
                        </span>
                        <span className={s.small}>{issue.message}</span>
                        <span className={styles.issueFix}>{issue.fix}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </CardBody>
      </Card>
      {validation?.composition ? (
        <Card aria-labelledby="composition-title">
          <CardHeader
            titleId="composition-title"
            title="Composition"
            description="What the selected packs add."
          />
          <CardBody>
            <CompositionView composition={validation.composition} compact />
          </CardBody>
        </Card>
      ) : validation ? (
        <Card>
          <CardBody>
            <p className={`${s.muted} ${s.small}`}>
              <ListChecks
                aria-hidden="true"
                style={{ display: 'inline', width: '1em', verticalAlign: '-0.15em' }}
              />{' '}
              The composition appears once the blueprint matches the schema.
            </p>
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}

function SaveDialog({
  project,
  body,
  blocking,
  onClose,
  onSaved,
}: {
  project: Project;
  body: BlueprintBody;
  blocking: number;
  onClose: () => void;
  onSaved: (v: VersionDetail) => void;
}) {
  const save = useSaveVersion(project.id);
  const [message, setMessage] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const length = message.trim().length;
  const clientError = length < 5 ? `Write at least 5 characters (${length} so far).` : undefined;
  const serverField = isApiError(save.error) ? save.error.fieldErrors.message : undefined;

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Save a new blueprint version"
      description="Every save is a new numbered version, committed to the project's git history. Saved versions never change; approval happens per version."
      submitLabel="Save version"
      pending={save.isPending}
      error={save.error}
      fields={['message']}
      onSubmit={() => {
        setSubmitted(true);
        if (clientError) return;
        save.mutate(
          { ...body, message: message.trim() },
          {
            onSuccess: (v) => {
              toast.success(`Version ${v.number} saved`, {
                description: v.validation.ok
                  ? 'No blocking problems. It can now be approved.'
                  : `${v.validation.blocking} blocking problem(s) to fix before approval.`,
              });
              onSaved(v);
            },
          },
        );
      }}
    >
      {blocking > 0 ? (
        <Callout
          tone="warning"
          title={`This draft has ${blocking} blocking problem${blocking === 1 ? '' : 's'}`}
        >
          You can still save it, but it cannot be approved until they are fixed.
        </Callout>
      ) : null}
      <Field
        label="Why are you saving this version?"
        help="Shown in the version history and the git commit. At least 5 characters."
        error={(submitted ? clientError : undefined) ?? serverField}
        required
      >
        <Textarea
          rows={3}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={2000}
        />
      </Field>
      <p className={`${s.muted} ${s.xs}`}>
        <FileCode
          aria-hidden="true"
          style={{ display: 'inline', width: '1em', verticalAlign: '-0.15em' }}
        />{' '}
        Saved from the {'yaml_text' in body ? 'YAML file' : 'form'}.
      </p>
    </FormDialog>
  );
}
