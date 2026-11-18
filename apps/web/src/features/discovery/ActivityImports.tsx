import { Upload } from 'lucide-react';
import { useId, useState } from 'react';
import { useActivityImports, useUploadActivity } from '@/api/discovery';
import { isApiError } from '@/api/errors';
import type { SourceConnection } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { Button, Callout, Mono, PlainText, Skeleton, Timestamp, toast } from '@/ui';
import s from '../shared.module.css';
import { toBase64 } from '../packs/model';
import { activityFileError } from './model';
import styles from './Discovery.module.css';

const EXAMPLE = `{"timestamp": "2026-10-01T08:15:00Z", "login": "app_user", "host": "ws-014", "program": "Report tool", "statement": "SELECT * FROM dbo.example"}
{"timestamp": "2026-10-01T08:16:02Z", "login": "app_user", "host": "ws-014", "program": "Report tool", "statement": ""}`;

/** Activity records (logins and queries) imported for one source connection. */
export function ActivityImports({ connection }: { connection: SourceConnection }) {
  const list = useActivityImports(connection.id);
  const [open, setOpen] = useState(false);
  return (
    <section aria-label={`Activity imports for ${connection.name}`}>
      <div
        className={s.row}
        style={{ justifyContent: 'space-between', marginBottom: 'var(--space-2)' }}
      >
        <h3 className={s.cellPrimary}>Activity imports</h3>
        {connection.can_manage ? (
          <Button
            size="sm"
            leadingIcon={<Upload aria-hidden="true" />}
            onClick={() => setOpen(true)}
          >
            Import activity
          </Button>
        ) : null}
      </div>
      <p className={`${s.muted} ${s.xs}`} style={{ marginBottom: 'var(--space-2)' }}>
        Login and query records let discovery measure usage and find interfaces that only show in
        activity.
      </p>
      {list.isPending ? (
        <Skeleton height="2.5rem" />
      ) : list.isError ? (
        <ApiErrorView
          error={list.error}
          title="Could not load activity imports"
          compact
          onRetry={() => void list.refetch()}
        />
      ) : list.data.length === 0 ? (
        <p className={s.muted}>No activity imported yet.</p>
      ) : (
        <ul className={styles.plainList}>
          {list.data.map((i) => (
            <li key={i.id} className={s.row}>
              <Mono className={s.small}>{i.filename}</Mono>
              <span className={s.small}>
                {i.records.toLocaleString()} records over {i.days} day{i.days === 1 ? '' : 's'}
              </span>
              {i.first_at && i.last_at ? (
                <span className={`${s.muted} ${s.xs}`}>
                  <Timestamp value={i.first_at} /> to <Timestamp value={i.last_at} />
                </span>
              ) : null}
              <span className={`${s.muted} ${s.xs}`}>
                imported <Timestamp value={i.created_at} />
                {i.created_by ? ` by ${i.created_by}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open ? <ImportDialog connection={connection} onClose={() => setOpen(false)} /> : null}
    </section>
  );
}

function ImportDialog({
  connection,
  onClose,
}: {
  connection: SourceConnection;
  onClose: () => void;
}) {
  const upload = useUploadActivity(connection.id);
  const inputId = useId();
  const errorId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [reading, setReading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const clientError = file ? activityFileError(file) : 'Choose a file.';
  const serverError = isApiError(upload.error)
    ? (upload.error.fieldErrors.content_base64 ?? upload.error.fieldErrors.filename)
    : undefined;
  const shown = (submitted ? clientError : null) ?? serverError;
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Import activity for ${connection.name}`}
      submitLabel="Import"
      size="lg"
      pending={reading || upload.isPending}
      error={upload.error}
      fields={['content_base64', 'filename']}
      onSubmit={() => {
        setSubmitted(true);
        if (clientError || !file) return;
        setReading(true);
        void file
          .arrayBuffer()
          .then((buf) => {
            setReading(false);
            upload.mutate(
              { filename: file.name, content_base64: toBase64(new Uint8Array(buf)) },
              {
                onSuccess: (imp) => {
                  toast.success(`Imported ${imp.records.toLocaleString()} records`);
                  onClose();
                },
              },
            );
          })
          .catch(() => setReading(false));
      }}
    >
      <div className={s.stackSm}>
        <h3 className={s.cellPrimary}>The activity format</h3>
        <p className={s.small}>
          One record per line (JSONL) or one per row of a CSV file with a header. Each record has:
        </p>
        <ul className={s.small} style={{ paddingLeft: 'var(--space-5)' }}>
          <li>
            <Mono>timestamp</Mono>: when it happened, ISO 8601 (for example 2026-10-01T08:15:00Z)
          </li>
          <li>
            <Mono>login</Mono>: the database login
          </li>
          <li>
            <Mono>host</Mono>: the client machine
          </li>
          <li>
            <Mono>program</Mono>: the client program name
          </li>
          <li>
            <Mono>statement</Mono>: the SQL statement; leave it empty for a login record
          </li>
        </ul>
        <PlainText label="Example JSONL records">{EXAMPLE}</PlainText>
        <p className={`${s.muted} ${s.xs}`}>
          Up to 25 MB per file; split larger logs. Statements are parsed to find what each program
          reads, writes and runs.
        </p>
      </div>
      <div className={s.stackSm}>
        <label htmlFor={inputId} className={s.cellPrimary}>
          File (.jsonl or .csv) <span aria-hidden="true">*</span>
        </label>
        <input
          id={inputId}
          type="file"
          accept=".jsonl,.ndjson,.json,.csv"
          required
          aria-invalid={shown ? true : undefined}
          aria-describedby={shown ? errorId : undefined}
          className={styles.fileInput}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            if (upload.error) upload.reset();
          }}
        />
        {file ? (
          <span className={`${s.muted} ${s.xs}`}>
            {file.name}, {(file.size / 1024).toFixed(1)} KB
          </span>
        ) : null}
        {shown ? (
          <Callout tone="danger" live>
            <span id={errorId}>{shown}</span>
          </Callout>
        ) : null}
      </div>
    </FormDialog>
  );
}
