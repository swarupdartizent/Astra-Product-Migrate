import { Download, FilePlus, ShieldCheck } from 'lucide-react';
import { Fragment, useState } from 'react';
import { saveBlob } from '@/api/client';
import {
  useCreateProofPack,
  useDownloadProofPack,
  useProofPacks,
  useProofPackVerification,
} from '@/api/gates';
import type { ProofPack, ProofPackList } from '@/api/gates-types';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { FormError } from '@/app/FormError';
import { hasErrors, mergeFieldErrors, type FieldErrors } from '@/lib/forms';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CopyButton,
  EmptyState,
  Field,
  KeyValueList,
  Mono,
  RadioCards,
  Select,
  Skeleton,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from './Gates.module.css';
import { formatBytes, PACK_SECTIONS, shortDigest } from './model';

/**
 * Proof packs (E17.F2.S1): numbered, signed packs of the project's configuration, scope,
 * lineage, decisions, controls and gates, tests, agent records, cutover and decommission.
 */
export function ProofPacksView({ project }: { project: Project }) {
  const q = useProofPacks(project.id);
  if (q.isPending) return <Skeleton height="16rem" />;
  if (q.isError) {
    return (
      <ApiErrorView
        error={q.error}
        title="Could not load the proof packs"
        onRetry={() => void q.refetch()}
      />
    );
  }
  return <Packs project={project} data={q.data} />;
}

function Packs({ project, data }: { project: Project; data: ProofPackList }) {
  const [creating, setCreating] = useState(false);
  const [verifying, setVerifying] = useState<ProofPack | null>(null);
  const download = useDownloadProofPack();
  const [downloading, setDownloading] = useState<string | null>(null);
  const why = data.can_create
    ? null
    : 'Creating a proof pack needs stage management on this project.';
  const get = (pack: ProofPack, format: 'json' | 'pdf') => {
    setDownloading(`${pack.id}:${format}`);
    download.mutate(
      { pack, format },
      {
        onSuccess: (file) => {
          saveBlob(file);
          toast.success(`Downloaded ${file.filename}`);
        },
        onSettled: () => setDownloading(null),
      },
    );
  };
  return (
    <div className={s.stack}>
      <Card flush aria-labelledby="packs-head">
        <CardHeader
          titleId="packs-head"
          title={`Proof packs (${String(data.packs.length)})`}
          description="Each pack is canonical JSON plus a PDF rendered from it, signed together with the platform’s Ed25519 key. A signed pack cannot be changed."
          actions={
            <Button
              variant="primary"
              leadingIcon={<FilePlus aria-hidden="true" />}
              disabled={!!why}
              aria-describedby={why ? 'pack-create-why' : undefined}
              onClick={() => setCreating(true)}
            >
              Create proof pack
            </Button>
          }
        />
        {why ? (
          <CardBody>
            <span id="pack-create-why" className={`${s.muted} ${s.small}`}>
              {why}
            </span>
          </CardBody>
        ) : null}
        {download.error ? (
          <CardBody>
            <FormError error={download.error} />
          </CardBody>
        ) : null}
        {data.packs.length === 0 ? (
          <EmptyState
            compact
            title="No proof packs yet"
            body="Create a pack for the whole project or for one wave."
          />
        ) : (
          <div
            className={styles.tableWrap}
            // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Proof packs"
          >
            <table className={styles.table}>
              <caption className="sr-only">
                Signed proof packs, newest first, with their digests and downloads
              </caption>
              <thead>
                <tr>
                  <th scope="col">Pack</th>
                  <th scope="col">Scope</th>
                  <th scope="col">Created</th>
                  <th scope="col">Items</th>
                  <th scope="col">Digests (sha256)</th>
                  <th scope="col">Key version</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.packs.map((p) => (
                  <tr key={p.id}>
                    <th scope="row">Pack {p.number}</th>
                    <td>{p.scope === 'wave' ? `Wave ${p.wave ?? ''}` : 'Whole project'}</td>
                    <td>
                      <span className={s.cellStack}>
                        <span>{p.created_by ?? 'Unknown'}</span>
                        {p.created_at ? <Timestamp value={p.created_at} /> : null}
                      </span>
                    </td>
                    <td>
                      <dl
                        className={styles.counts}
                        aria-label={`Items in pack ${String(p.number)}`}
                      >
                        {PACK_SECTIONS.map((sec) => (
                          <Fragment key={sec.key}>
                            <dt>{sec.title}</dt>
                            <dd>{(p.summary.counts[sec.key] ?? 0).toLocaleString()}</dd>
                          </Fragment>
                        ))}
                        <dt>Total</dt>
                        <dd>{p.summary.items.toLocaleString()}</dd>
                      </dl>
                    </td>
                    <td>
                      <span className={s.cellStack}>
                        <Digest label="JSON" value={p.json_sha256} pack={p.number} />
                        <Digest label="PDF" value={p.pdf_sha256} pack={p.number} />
                        <span className={styles.digest}>
                          <span className={s.xs}>Signature</span>
                          <CopyButton
                            value={p.signature}
                            label={`Copy the signature of pack ${String(p.number)}`}
                          />
                        </span>
                        {p.summary.bytes ? (
                          <span className={`${s.xs} ${s.muted}`}>
                            PDF {formatBytes(p.summary.bytes)}
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td>
                      <Mono>{p.signing_key}</Mono> v{p.key_version}
                    </td>
                    <td>
                      <span className={styles.actions}>
                        <Button
                          size="sm"
                          variant="secondary"
                          leadingIcon={<Download aria-hidden="true" />}
                          loading={downloading === `${p.id}:json`}
                          disabled={downloading !== null}
                          aria-label={`Download pack ${String(p.number)} as JSON`}
                          onClick={() => get(p, 'json')}
                        >
                          JSON
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          leadingIcon={<Download aria-hidden="true" />}
                          loading={downloading === `${p.id}:pdf`}
                          disabled={downloading !== null}
                          aria-label={`Download pack ${String(p.number)} as PDF`}
                          onClick={() => get(p, 'pdf')}
                        >
                          PDF
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          leadingIcon={<ShieldCheck aria-hidden="true" />}
                          aria-label={`Verify pack ${String(p.number)}`}
                          onClick={() => setVerifying(p)}
                        >
                          Verify
                        </Button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {verifying ? (
        <VerifyResult key={verifying.id} pack={verifying} onClose={() => setVerifying(null)} />
      ) : null}
      {creating ? (
        <CreatePackDialog project={project} waves={data.waves} onClose={() => setCreating(false)} />
      ) : null}
    </div>
  );
}

function Digest({ label, value, pack }: { label: string; value: string; pack: number }) {
  return (
    <span className={styles.digest}>
      <span className={s.xs}>{label}</span>
      <Mono title={value}>{shortDigest(value)}</Mono>
      <CopyButton value={value} label={`Copy the ${label} sha256 of pack ${String(pack)}`} />
    </span>
  );
}

function VerifyResult({ pack, onClose }: { pack: ProofPack; onClose: () => void }) {
  const q = useProofPackVerification(pack.id);
  const v = q.data;
  return (
    <Card aria-labelledby="verify-head">
      <CardHeader
        titleId="verify-head"
        title={`Verification of pack ${String(pack.number)}`}
        description="Both digests are recomputed from the stored files and the signature is checked with the signing key."
        actions={
          <span className={styles.actions}>
            <Button
              size="sm"
              variant="secondary"
              loading={q.isFetching}
              onClick={() => void q.refetch()}
            >
              Verify again
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </span>
        }
      />
      <CardBody className={s.stackSm}>
        <div role="status" aria-live="polite" className={s.stackSm}>
          {q.isPending ? (
            <span className={s.muted}>Verifying…</span>
          ) : q.isError ? (
            <ApiErrorView error={q.error} title="Could not verify the pack" compact />
          ) : v ? (
            <Callout
              tone={v.valid ? 'success' : 'danger'}
              title={
                v.valid
                  ? `Pack ${String(pack.number)} is intact and its signature is valid`
                  : `Pack ${String(pack.number)} failed verification`
              }
            >
              {v.valid
                ? 'The recomputed digests match the record and the signature verifies.'
                : [
                    v.matches_record ? null : 'The recomputed digests do not match the record.',
                    v.signature_valid ? null : 'The signature does not verify.',
                  ]
                    .filter(Boolean)
                    .join(' ')}
            </Callout>
          ) : null}
        </div>
        {v ? (
          <KeyValueList
            items={[
              {
                key: 'j',
                label: 'JSON sha256 (recomputed)',
                value: (
                  <span className={s.cellStack}>
                    <Mono className={styles.key}>{v.json_sha256}</Mono>
                    <span className={s.badges}>
                      <Badge tone={v.json_sha256 === pack.json_sha256 ? 'success' : 'danger'}>
                        {v.json_sha256 === pack.json_sha256
                          ? 'Matches the record'
                          : 'Differs from the record'}
                      </Badge>
                    </span>
                  </span>
                ),
              },
              {
                key: 'p',
                label: 'PDF sha256 (recomputed)',
                value: (
                  <span className={s.cellStack}>
                    <Mono className={styles.key}>{v.pdf_sha256}</Mono>
                    <span className={s.badges}>
                      <Badge tone={v.pdf_sha256 === pack.pdf_sha256 ? 'success' : 'danger'}>
                        {v.pdf_sha256 === pack.pdf_sha256
                          ? 'Matches the record'
                          : 'Differs from the record'}
                      </Badge>
                    </span>
                  </span>
                ),
              },
              {
                key: 's',
                label: 'Signature',
                value: (
                  <Badge tone={v.signature_valid ? 'success' : 'danger'}>
                    {v.signature_valid ? 'Valid' : 'Not valid'}
                  </Badge>
                ),
              },
              { key: 'k', label: 'Key version', value: `v${String(v.key_version)}` },
            ]}
          />
        ) : null}
      </CardBody>
    </Card>
  );
}

const NO_WAVE = '';

function CreatePackDialog({
  project,
  waves,
  onClose,
}: {
  project: Project;
  waves: string[];
  onClose: () => void;
}) {
  const create = useCreateProofPack(project.id);
  const [scope, setScope] = useState<'project' | 'wave'>('project');
  const [wave, setWave] = useState(NO_WAVE);
  const [submitted, setSubmitted] = useState(false);
  const client: FieldErrors<'wave'> =
    scope === 'wave' && !wave ? { wave: 'Choose the wave the pack covers.' } : {};
  const errors = mergeFieldErrors(client, create.error, submitted);
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Create a proof pack"
      description="The pack is built from the records as they are now, rendered to PDF and signed. It gets the next number and cannot be changed afterwards."
      submitLabel="Create and sign"
      pending={create.isPending}
      error={create.error}
      fields={['wave']}
      progress={<span className={s.muted}>Building, rendering and signing the pack…</span>}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(client)) return;
        create.mutate(scope === 'wave' ? { wave } : {}, {
          onSuccess: (p) => {
            toast.success(`Proof pack ${String(p.number)} signed`);
            onClose();
          },
        });
      }}
    >
      <RadioCards
        legend="Scope"
        name="pack-scope"
        value={scope}
        onValueChange={setScope}
        options={[
          {
            value: 'project',
            label: 'Whole project',
            description: 'Every scope item, its lineage and every record of the project.',
          },
          {
            value: 'wave',
            label: 'One wave',
            description:
              waves.length > 0
                ? 'The scope items assigned to one wave and their lineage.'
                : 'The plan has no waves yet.',
            disabled: waves.length === 0,
          },
        ]}
      />
      {scope === 'wave' ? (
        <Field label="Wave" required error={errors.wave}>
          <Select
            options={waves.map((w) => ({ value: w, label: w }))}
            value={wave}
            onValueChange={setWave}
            placeholder="Choose a wave"
          />
        </Field>
      ) : null}
    </FormDialog>
  );
}
