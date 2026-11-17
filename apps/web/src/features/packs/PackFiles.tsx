import { FileText } from 'lucide-react';
import { useState } from 'react';
import { usePackFile } from '@/api/packs';
import type { PackDetail } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { Callout, Card, CardBody, CardHeader, CodeBlock, EmptyState, Mono, Skeleton } from '@/ui';
import s from '../shared.module.css';
import styles from './Packs.module.css';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function PackFiles({ pack }: { pack: PackDetail }) {
  const [path, setPath] = useState<string | null>(
    pack.files.some((f) => f.path === 'pack.yaml') ? 'pack.yaml' : null,
  );
  const file = usePackFile(pack.name, pack.version, path);

  return (
    <div className={styles.filesLayout}>
      <Card flush aria-labelledby="files-title">
        <CardHeader titleId="files-title" title="Files" description="Select a file to read it." />
        {pack.files.length === 0 ? (
          <EmptyState compact title="No files" />
        ) : (
          <ul className={styles.fileList} aria-label="Pack files">
            {pack.files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  className={styles.fileButton}
                  aria-pressed={path === f.path}
                  aria-controls="pack-file-view"
                  onClick={() => setPath(f.path)}
                >
                  <FileText aria-hidden="true" />
                  <Mono className={styles.filePath}>{f.path}</Mono>
                  <span className={`${s.muted} ${s.xs}`}>{formatBytes(f.size)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <div id="pack-file-view" aria-live="polite">
        {path === null ? (
          <Card>
            <CardBody>
              <EmptyState compact icon={<FileText />} title="Choose a file" />
            </CardBody>
          </Card>
        ) : file.isPending ? (
          <Skeleton height="16rem" />
        ) : file.isError ? (
          <ApiErrorView
            error={file.error}
            title={`Could not load ${path}`}
            onRetry={() => void file.refetch()}
            compact
          />
        ) : file.data.binary || file.data.text === null ? (
          <Callout tone="info" title={`${file.data.path} is a binary file`}>
            It is {formatBytes(file.data.size)} and cannot be shown as text.
          </Callout>
        ) : (
          <CodeBlock label={file.data.path} code={file.data.text} maxHeight="36rem" />
        )}
      </div>
    </div>
  );
}
