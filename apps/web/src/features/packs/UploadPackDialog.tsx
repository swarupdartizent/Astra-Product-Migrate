import { useNavigate } from '@tanstack/react-router';
import { FolderOpen, Files } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { isApiError } from '@/api/errors';
import { useUploadPack } from '@/api/packs';
import { FormDialog } from '@/app/FormDialog';
import { Button, Callout, Mono, toast } from '@/ui';
import s from '../shared.module.css';
import { buildBundle, BundleError, readFiles, type Bundle } from './model';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function UploadPackDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const upload = useUploadPack();
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [pickError, setPickError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  // React does not type the non-standard directory picker attribute; set it directly.
  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '');
    folderInput.current?.setAttribute('directory', '');
  }, []);

  async function onPick(list: FileList | null) {
    if (!list || list.length === 0) return;
    upload.reset();
    setReading(true);
    setPickError(null);
    try {
      const inputs = await readFiles(list);
      const built = buildBundle(inputs);
      const strip = built.strippedPrefix ? built.strippedPrefix.length + 1 : 0;
      setSizes(
        Object.fromEntries(
          inputs.map((f) => [f.path.replace(/\\/g, '/').slice(strip), f.bytes.length]),
        ),
      );
      setBundle(built);
    } catch (e) {
      setBundle(null);
      setPickError(e instanceof BundleError ? e.message : 'The files could not be read.');
    } finally {
      setReading(false);
    }
  }

  const paths = bundle ? Object.keys(bundle.files).sort() : [];
  const manifestErrors =
    isApiError(upload.error) && upload.error.problem.type.endsWith('/pack-invalid')
      ? upload.error.fieldErrorList
      : [];

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Upload pack"
      description="Choose the pack's folder (it must contain pack.yaml at its root), or select the files themselves. The pack is registered as a draft; test, review and publish it from its page."
      submitLabel="Upload as draft"
      size="lg"
      pending={upload.isPending}
      error={manifestErrors.length > 0 ? null : upload.error}
      onSubmit={() => {
        if (!bundle) {
          setPickError('Choose a pack folder or its files first.');
          return;
        }
        upload.mutate(bundle.files, {
          onSuccess: (pack) => {
            toast.success(`${pack.name}@${pack.version} uploaded as a draft`, {
              description: 'Run its tests next.',
            });
            onClose();
            void navigate({
              to: '/packs/$name/$version',
              params: { name: pack.name, version: pack.version },
            });
          },
        });
      }}
    >
      <div className={s.row}>
        <input
          ref={folderInput}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => void onPick(e.target.files)}
        />
        <input
          ref={filesInput}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => void onPick(e.target.files)}
        />
        <Button
          leadingIcon={<FolderOpen aria-hidden="true" />}
          onClick={() => folderInput.current?.click()}
          loading={reading}
        >
          Choose folder
        </Button>
        <Button
          leadingIcon={<Files aria-hidden="true" />}
          onClick={() => filesInput.current?.click()}
        >
          Choose files
        </Button>
      </div>
      {pickError ? (
        <Callout tone="danger" title="Cannot use these files" live>
          {pickError}
        </Callout>
      ) : null}
      {bundle ? (
        <section aria-labelledby="bundle-title" className={s.stackSm}>
          <h3 id="bundle-title" className={s.cellPrimary}>
            {paths.length} file{paths.length === 1 ? '' : 's'} to upload
            {bundle.strippedPrefix ? (
              <span className={`${s.muted} ${s.small}`}>
                {' '}
                from folder <Mono>{bundle.strippedPrefix}</Mono>
              </span>
            ) : null}
          </h3>
          <ul
            className={s.small}
            style={{
              maxHeight: '12rem',
              overflowY: 'auto',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-2) var(--space-3)',
              listStyle: 'none',
            }}
          >
            {paths.map((p) => (
              <li key={p} className={s.row} style={{ justifyContent: 'space-between' }}>
                <Mono>{p}</Mono>
                <span className={s.muted}>{formatBytes(sizes[p] ?? 0)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {manifestErrors.length > 0 && isApiError(upload.error) ? (
        <Callout tone="danger" title={upload.error.title} live>
          <ul style={{ paddingLeft: 'var(--space-4)', marginTop: 'var(--space-1)' }}>
            {manifestErrors.map((e, i) => (
              <li key={i}>
                <Mono>{e.field || 'pack.yaml'}</Mono>: {e.message}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
    </FormDialog>
  );
}
