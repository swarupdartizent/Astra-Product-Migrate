import { Plus, Trash, UserX } from 'lucide-react';
import { useState } from 'react';
import { useRevokeRole, useSetUserActive } from '@/api/access';
import type { Assignment, User } from '@/api/types';
import { FormDialog } from '@/app/FormDialog';
import { useMe } from '@/api/queries';
import { hasErrors, mergeFieldErrors, type FieldErrors } from '@/lib/forms';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  KeyValueList,
  Mono,
  Sheet,
  StatusPill,
  Textarea,
  Timestamp,
  toast,
  Tooltip,
} from '@/ui';
import s from '../shared.module.css';
import { GrantRoleDialog } from './GrantRoleDialog';
import { SCOPE_LABELS, USER_STATUS } from './model';
import styles from './UserPanel.module.css';

export interface UserPanelProps {
  user: User;
  canManage: boolean;
  onClose: () => void;
}

export function UserPanel({ user, canManage, onClose }: UserPanelProps) {
  const me = useMe();
  const revoke = useRevokeRole();
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState<Assignment | null>(null);
  const [toggling, setToggling] = useState(false);
  const status = USER_STATUS[user.status];
  const isSelf = me.data?.id === user.id;

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={user.display_name}
      description={user.email}
      size="lg"
    >
      <KeyValueList
        items={[
          {
            key: 'status',
            label: 'Status',
            value: <StatusPill tone={status.tone}>{status.label}</StatusPill>,
          },
          {
            key: 'seen',
            label: 'Last seen',
            value: user.last_seen_at ? <Timestamp value={user.last_seen_at} /> : 'Never signed in',
          },
          { key: 'id', label: 'User ID', value: <Mono>{user.id}</Mono> },
        ]}
      />

      <section aria-labelledby="assignments-title" className={s.stackSm}>
        <div className={styles.sectionHeader}>
          <h3 id="assignments-title" className={styles.sectionTitle}>
            Roles
          </h3>
          {canManage ? (
            <Button
              size="sm"
              leadingIcon={<Plus aria-hidden="true" />}
              onClick={() => setGranting(true)}
            >
              Grant role
            </Button>
          ) : null}
        </div>
        {user.assignments.length === 0 ? (
          <EmptyState
            compact
            title="No roles"
            body="This person can sign in but cannot see or do anything yet."
          />
        ) : (
          <ul className={styles.assignments}>
            {user.assignments.map((a) => (
              <li key={a.id} className={styles.assignment}>
                <div className={s.cellStack}>
                  <span className={s.cellPrimary}>{a.role_label}</span>
                  <span className={`${s.muted} ${s.small}`}>
                    <Badge tone={a.scope_type === 'platform' ? 'accent' : 'neutral'}>
                      {SCOPE_LABELS[a.scope_type]}
                    </Badge>{' '}
                    {a.scope_type === 'platform'
                      ? null
                      : (a.scope_name ?? <Mono>{a.scope_id}</Mono>)}
                    {' · granted '}
                    <Timestamp value={a.granted_at} />
                  </span>
                </div>
                {canManage ? (
                  <Tooltip content="Remove role">
                    <IconButton
                      size="sm"
                      label={`Remove ${a.role_label} (${a.scope_name ?? SCOPE_LABELS[a.scope_type]})`}
                      icon={<Trash aria-hidden="true" />}
                      onClick={() => setRevoking(a)}
                    />
                  </Tooltip>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canManage && !isSelf ? (
        <section aria-labelledby="account-title" className={s.stackSm}>
          <h3 id="account-title" className={styles.sectionTitle}>
            Account
          </h3>
          <p className={`${s.muted} ${s.small}`}>
            {user.status === 'disabled'
              ? 'This account is disabled: the person cannot use Astra Migrate even with a valid sign-in.'
              : 'Disabling blocks every request from this person immediately. Their roles are kept.'}{' '}
            Only platform administrators can change this.
          </p>
          <div>
            <Button
              size="sm"
              variant={user.status === 'disabled' ? 'secondary' : 'danger'}
              leadingIcon={<UserX aria-hidden="true" />}
              onClick={() => setToggling(true)}
            >
              {user.status === 'disabled' ? 'Enable account' : 'Disable account'}
            </Button>
          </div>
        </section>
      ) : null}

      {granting ? <GrantRoleDialog user={user} onClose={() => setGranting(false)} /> : null}
      {toggling ? <SetActiveDialog user={user} onClose={() => setToggling(false)} /> : null}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        tone="danger"
        title="Remove this role?"
        description={
          revoking
            ? `${user.display_name} loses ${revoking.role_label} at ${revoking.scope_name ?? SCOPE_LABELS[revoking.scope_type]} immediately. You can grant it again later.`
            : ''
        }
        confirmLabel="Remove role"
        onConfirm={async () => {
          if (!revoking) return;
          await revoke.mutateAsync(revoking.id);
          toast.success(`${revoking.role_label} removed from ${user.display_name}`);
        }}
      />
    </Sheet>
  );
}

function SetActiveDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const enable = user.status === 'disabled';
  const setActive = useSetUserActive(user.id);
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const clientErrors: FieldErrors<'reason'> = {};
  const length = reason.trim().length;
  if (length < 5) clientErrors.reason = `Write at least 5 characters (${length} so far).`;
  const errors = mergeFieldErrors(clientErrors, setActive.error, submitted);

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      tone={enable ? 'default' : 'danger'}
      size="sm"
      title={enable ? `Enable ${user.display_name}?` : `Disable ${user.display_name}?`}
      description={
        enable
          ? 'They can use Astra Migrate again with the roles they hold.'
          : 'Every request from this person is refused from now on. Their roles are kept so you can enable them later.'
      }
      submitLabel={enable ? 'Enable account' : 'Disable account'}
      pending={setActive.isPending}
      error={setActive.error}
      fields={['reason', 'active']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        setActive.mutate(
          { active: enable, reason: reason.trim() },
          {
            onSuccess: (u) => {
              toast.success(enable ? `${u.display_name} enabled` : `${u.display_name} disabled`);
              onClose();
            },
          },
        );
      }}
    >
      <Field
        label="Reason"
        help="At least 5 characters. Recorded in the audit log."
        error={errors.reason}
        required
      >
        <Textarea
          rows={3}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            if (setActive.error) setActive.reset();
          }}
          maxLength={1000}
        />
      </Field>
    </FormDialog>
  );
}
