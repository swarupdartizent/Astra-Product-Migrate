import { Scale, ShieldCheck, Upload } from 'lucide-react';
import { useId, useState } from 'react';
import { useApproveFormLayout, useFormParity, useUploadFormFile } from '@/api/design';
import type { DesignItemDetail, FormFile, FormParity } from '@/api/design-types';
import { isApiError } from '@/api/errors';
import type { Project } from '@/api/types';
import { FormError } from '@/app/FormError';
import { reasonError } from '@/lib/forms';
import {
  Button,
  Callout,
  Field,
  KeyValueList,
  Mono,
  PlainText,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import { toBase64 } from '../packs/model';
import s from '../shared.module.css';
import styles from './Design.module.css';
import { hasPdfHeader, pdfFileError, pretty, str } from './model';
import { Pair } from './Parts';

const ROLES = [
  {
    role: 'converted' as const,
    label: 'Converted form',
    help: 'The form produced in the target’s format.',
  },
  {
    role: 'golden' as const,
    label: 'Golden copy',
    help: 'The approved reference the converted form must match.',
  },
];

/**
 * A form: its source design, the target format, the converted and golden PDFs, and parity.
 * Approval waits for a passing parity check (shown as the item's readiness).
 */
export function FormBody({ project, item: it }: { project: Project; item: DesignItemDetail }) {
  const parity = useFormParity(project.id);
  const src = it.source;
  const tgt = it.target ?? {};
  const decided = it.status === 'approved' || it.status === 'rejected';
  const files = Object.fromEntries(it.files.map((f) => [f.role, f])) as Partial<
    Record<'converted' | 'golden', FormFile>
  >;
  const both = !!files.converted && !!files.golden;
  const uploadWhy = !it.can_decide
    ? (it.cannot_decide_reason ?? 'You cannot change this form.')
    : decided
      ? `The form is ${it.status}; its files cannot change.`
      : null;
  const parityWhy = decided
    ? `The form is ${it.status}.`
    : !both
      ? 'Upload the converted form and its golden copy first.'
      : null;
  const result = it.parity;
  return (
    <>
      <Pair
        source={
          <>
            <KeyValueList
              items={[
                { key: 'k', label: 'Kind', value: <Mono>{str(src.kind)}</Mono> },
                { key: 'n', label: 'Name', value: str(src.name) },
                { key: 's', label: 'Scope', value: str(src.scope) },
              ]}
            />
            <PlainText
              label={`Source design of ${it.key}`}
              empty={<p className={s.muted}>No definition.</p>}
            >
              {pretty(src.definition)}
            </PlainText>
          </>
        }
        target={
          <KeyValueList
            items={[
              { key: 'f', label: 'Format', value: (str(tgt.format) ?? '').toUpperCase() || null },
              {
                key: 'c',
                label: 'Conversion',
                value:
                  str(tgt.conversion) === 'carry_over'
                    ? 'Already in the target format: carried over'
                    : 'Needs conversion to the target format',
              },
            ]}
          />
        }
      />
      <section className={styles.section} aria-labelledby={`files-${it.key}`}>
        <h3 id={`files-${it.key}`} className={styles.sectionTitle}>
          Files for parity
        </h3>
        <div className={styles.uploads}>
          {ROLES.map((r) => (
            <FileSlot
              key={r.role}
              project={project}
              item={it}
              role={r.role}
              label={r.label}
              help={r.help}
              current={files[r.role] ?? null}
              disabledWhy={uploadWhy}
            />
          ))}
        </div>
      </section>
      <section className={styles.section} aria-labelledby={`parity-${it.key}`}>
        <h3 id={`parity-${it.key}`} className={styles.sectionTitle}>
          Parity
        </h3>
        <p className={`${s.muted} ${s.small}`}>
          Compares page count, page sizes, the text of each page and the form fields (names and
          types). It passes only when all of them match.
        </p>
        <div className={s.row}>
          <Button
            leadingIcon={<Scale aria-hidden="true" />}
            disabled={!!parityWhy}
            loading={parity.isPending}
            aria-describedby={parityWhy ? `parity-why-${it.key}` : undefined}
            onClick={() => parity.mutate(it.key)}
          >
            Run parity
          </Button>
          {parityWhy ? (
            <span id={`parity-why-${it.key}`} className={`${s.muted} ${s.small}`}>
              {parityWhy}
            </span>
          ) : null}
        </div>
        <FormError error={parity.error} />
        <div role="status" aria-live="polite">
          {result ? (
            <Callout
              tone={
                result.passed || result.layout_approval
                  ? 'success'
                  : result.layout_only
                    ? 'warning'
                    : 'danger'
              }
              title={
                result.passed
                  ? 'Parity passed'
                  : result.layout_only
                    ? `Layout only: ${String(result.differences.length)} difference(s)`
                    : `Parity failed: ${String(result.differences.length)} difference(s)`
              }
            >
              <p className={s.small}>
                Pages {result.pages} of {result.golden_pages} · fields {result.fields} of{' '}
                {result.golden_fields} · checked by {result.by} <Timestamp value={result.at} />
              </p>
              <ParityDifferences result={result} />
            </Callout>
          ) : (
            <p className={`${s.muted} ${s.small}`}>
              {both
                ? 'Parity has not been run on these files.'
                : 'No parity result yet. A new upload clears the previous result.'}
            </p>
          )}
        </div>
        {result && !result.passed && result.layout_only ? (
          <LayoutApproval project={project} item={it} result={result} />
        ) : null}
      </section>
    </>
  );
}

/** Content differences fail the test; layout-only differences (page count or size) can be approved. */
function ParityDifferences({ result }: { result: FormParity }) {
  // Results stored before content and layout were separated only carry `differences`.
  const split = result.content_differences !== undefined || result.layout_differences !== undefined;
  if (!split) {
    return result.differences.length > 0 ? (
      <ul className={styles.bullets}>
        {result.differences.map((d, i) => (
          <li key={`${String(i)}:${d}`}>{d}</li>
        ))}
      </ul>
    ) : null;
  }
  const content = result.content_differences ?? [];
  const layout = result.layout_differences ?? [];
  return (
    <>
      {content.length > 0 ? (
        <>
          <h4 className={styles.subTitle}>
            Content differences ({content.length}): these fail the test
          </h4>
          <ul className={styles.bullets} aria-label="Content differences">
            {content.map((d, i) => (
              <li key={`c${String(i)}:${d}`}>{d}</li>
            ))}
          </ul>
        </>
      ) : null}
      {layout.length > 0 ? (
        <>
          <h4 className={styles.subTitle}>
            Layout differences ({layout.length}):{' '}
            {content.length ? 'approvable once content matches' : 'a person may approve them'}
          </h4>
          <ul className={styles.bullets} aria-label="Layout differences">
            {layout.map((d, i) => (
              <li key={`l${String(i)}:${d}`}>{d}</li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

function LayoutApproval({
  project,
  item: it,
  result,
}: {
  project: Project;
  item: DesignItemDetail;
  result: FormParity;
}) {
  const approve = useApproveFormLayout(project.id);
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const err = reasonError(note);
  const done = result.layout_approval;
  const decided = it.status === 'approved' || it.status === 'rejected';
  const why = !it.can_decide
    ? (it.cannot_decide_reason ?? 'You cannot decide this form.')
    : decided
      ? `The form is ${it.status}.`
      : null;
  const serverNote = isApiError(approve.error) ? approve.error.fieldErrors.note : undefined;
  if (done) {
    return (
      <Callout tone="success" title="Layout differences approved">
        Approved by {done.by} <Timestamp value={done.at} />: “{done.note}”
      </Callout>
    );
  }
  return (
    <section className={styles.step} aria-labelledby={`layout-${it.key}`}>
      <h4 id={`layout-${it.key}`} className={styles.subTitle}>
        Approve layout differences
      </h4>
      <p className={`${s.muted} ${s.small}`}>
        Only the page count or page sizes differ from the golden copy. Approving records your name
        and note; the form can then be approved.
      </p>
      <Field
        label="Approval note"
        required
        help="At least 10 characters. Say why the layout difference is acceptable."
        error={(tried ? err : undefined) ?? serverNote}
        disabled={!!why}
      >
        <Textarea
          rows={2}
          value={note}
          maxLength={2000}
          disabled={!!why}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <div className={s.row}>
        <Button
          variant="primary"
          leadingIcon={<ShieldCheck aria-hidden="true" />}
          disabled={!!why}
          loading={approve.isPending}
          aria-describedby={why ? `layout-why-${it.key}` : undefined}
          onClick={() => {
            setTried(true);
            if (err) return;
            approve.mutate(
              { key: it.key, note: note.trim() },
              { onSuccess: () => toast.success('Layout differences approved') },
            );
          }}
        >
          Approve layout differences
        </Button>
        {why ? (
          <span id={`layout-why-${it.key}`} className={`${s.muted} ${s.small}`}>
            {why}
          </span>
        ) : null}
      </div>
      <FormError error={approve.error} fields={['note']} />
    </section>
  );
}

function FileSlot({
  project,
  item: it,
  role,
  label,
  help,
  current,
  disabledWhy,
}: {
  project: Project;
  item: DesignItemDetail;
  role: 'converted' | 'golden';
  label: string;
  help: string;
  current: FormFile | null;
  disabledWhy: string | null;
}) {
  const upload = useUploadFormFile(project.id);
  const inputId = useId();
  const errorId = useId();
  const helpId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const serverError = isApiError(upload.error)
    ? (upload.error.fieldErrors.content_base64 ?? upload.error.fieldErrors.name)
    : undefined;
  const shown = clientError ?? serverError ?? null;
  const send = () => {
    if (!file) {
      setClientError('Choose a PDF file.');
      return;
    }
    const err = pdfFileError(file);
    if (err) {
      setClientError(err);
      return;
    }
    setReading(true);
    void file
      .arrayBuffer()
      .then((buf) => {
        setReading(false);
        const bytes = new Uint8Array(buf);
        if (!hasPdfHeader(bytes)) {
          setClientError('The file is not a PDF: it does not start with %PDF-.');
          return;
        }
        upload.mutate(
          { key: it.key, role, name: file.name.slice(0, 200), content_base64: toBase64(bytes) },
          {
            onSuccess: () => {
              toast.success(`${label} uploaded`);
              setFile(null);
            },
          },
        );
      })
      .catch(() => {
        setReading(false);
        setClientError('The file could not be read.');
      });
  };
  return (
    <div className={styles.step}>
      <label htmlFor={inputId} className={styles.subTitle}>
        {label}
      </label>
      <span id={helpId} className={`${s.muted} ${s.xs}`}>
        {help} PDF, up to 20 MB.
      </span>
      {current ? (
        <span className={s.small}>
          Uploaded: <strong>{current.name}</strong> ({(current.bytes / 1024).toFixed(1)} KB) by{' '}
          {current.uploaded_by}
          {current.uploaded_at ? (
            <>
              {' '}
              <Timestamp value={current.uploaded_at} />
            </>
          ) : null}
          <br />
          <span className={`${s.muted} ${s.xs}`}>
            SHA-256 <Mono>{current.sha256.slice(0, 16)}…</Mono>
          </span>
        </span>
      ) : (
        <span className={`${s.muted} ${s.small}`}>Not uploaded.</span>
      )}
      <input
        id={inputId}
        type="file"
        accept="application/pdf,.pdf"
        className={styles.fileInput}
        disabled={!!disabledWhy}
        aria-invalid={shown ? true : undefined}
        aria-describedby={[helpId, shown ? errorId : null].filter(Boolean).join(' ')}
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          setFile(f);
          setClientError(f ? (pdfFileError(f) ?? null) : null);
          if (upload.error) upload.reset();
        }}
      />
      <div className={s.row}>
        <Button
          size="sm"
          leadingIcon={<Upload aria-hidden="true" />}
          disabled={!!disabledWhy || !file}
          loading={reading || upload.isPending}
          onClick={send}
        >
          {current ? `Replace ${label.toLowerCase()}` : `Upload ${label.toLowerCase()}`}
        </Button>
        {disabledWhy ? <span className={`${s.muted} ${s.xs}`}>{disabledWhy}</span> : null}
      </div>
      {shown ? (
        <Callout tone="danger" live>
          <span id={errorId}>{shown}</span>
        </Callout>
      ) : null}
      {upload.error && !serverError ? <FormError error={upload.error} /> : null}
    </div>
  );
}
