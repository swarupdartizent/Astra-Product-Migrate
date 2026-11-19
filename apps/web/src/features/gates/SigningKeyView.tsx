import { useSigningKey } from '@/api/gates';
import { ApiErrorView } from '@/app/ApiErrorView';
import {
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  CopyButton,
  EmptyState,
  KeyValueList,
  Mono,
  Skeleton,
} from '@/ui';
import s from '../shared.module.css';
import styles from './Gates.module.css';

/** The public key that verifies proof packs offline, per key version. */
export function SigningKeyView() {
  const q = useSigningKey();
  if (q.isPending) return <Skeleton height="14rem" />;
  if (q.isError) {
    return (
      <ApiErrorView
        error={q.error}
        title="Could not load the signing key"
        onRetry={() => void q.refetch()}
      />
    );
  }
  const k = q.data;
  const versions = Object.entries(k.versions).sort(([a], [b]) => Number(b) - Number(a));
  return (
    <div className={s.stack}>
      <Card aria-labelledby="key-head">
        <CardHeader
          titleId="key-head"
          title="Signing key"
          description="Proof packs are signed with the platform’s vault-held key. The private key never leaves the vault; the public key below verifies a downloaded pack anywhere."
        />
        <CardBody className={s.stackSm}>
          <KeyValueList
            items={[
              { key: 'n', label: 'Key', value: <Mono>{k.key}</Mono> },
              { key: 'a', label: 'Algorithm', value: k.algorithm },
              { key: 't', label: 'Vault key type', value: k.type ?? null },
              { key: 'm', label: 'Signed message', value: k.message },
            ]}
          />
          <CodeBlock
            label="Signed message format"
            code="<sha256 of the JSON>:<sha256 of the PDF>"
          />
        </CardBody>
      </Card>
      <Card flush aria-labelledby="key-versions-head">
        <CardHeader
          titleId="key-versions-head"
          title={`Public keys (${String(versions.length)})`}
          description="Each pack names the key version that signed it. Keys are raw 32-byte Ed25519 public keys, base64 encoded."
        />
        {versions.length === 0 ? (
          <EmptyState compact title="No key versions" body="No pack has been signed yet." />
        ) : (
          <div
            className={styles.tableWrap}
            // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Public keys"
          >
            <table className={styles.table}>
              <caption className="sr-only">Public key for each signing key version</caption>
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Public key (base64)</th>
                </tr>
              </thead>
              <tbody>
                {versions.map(([v, pub]) => (
                  <tr key={v}>
                    <th scope="row">v{v}</th>
                    <td>
                      {pub ? (
                        <span className={styles.digest}>
                          <Mono className={styles.key}>{pub}</Mono>
                          <CopyButton value={pub} label={`Copy the public key of version ${v}`} />
                        </span>
                      ) : (
                        <span className={s.muted}>
                          The vault does not publish this version’s key.
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card aria-labelledby="offline-head">
        <CardHeader titleId="offline-head" title="How to verify a pack offline" />
        <CardBody>
          <ol className={styles.bullets}>
            <li>
              Download the pack’s JSON and PDF, and copy its signature from the Proof packs list.
            </li>
            <li>
              Compute the sha256 of each file’s bytes exactly as downloaded (for example{' '}
              <Mono>sha256sum proof-pack-1.json proof-pack-1.pdf</Mono>).
            </li>
            <li>
              Build the message: the JSON digest, a colon, then the PDF digest, as UTF-8 text in
              lowercase hex.
            </li>
            <li>
              The signature has the form <Mono>vault:v&lt;version&gt;:&lt;base64&gt;</Mono>: decode
              the part after the second colon.
            </li>
            <li>
              Verify it over the message with the Ed25519 public key of the pack’s key version above
              (for example with a standard Ed25519 library). Any change to either file changes its
              digest, and the check fails.
            </li>
          </ol>
        </CardBody>
      </Card>
    </div>
  );
}
