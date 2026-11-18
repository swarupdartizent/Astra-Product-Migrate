import { useId, useState } from 'react';
import { useDecideReview } from '@/api/runtime';
import type {
  ReviewDecideIn,
  ReviewDecideOut,
  Project,
  ReviewAction,
  ReviewItem,
} from '@/api/types';
import { FormError } from '@/app/FormError';
import { mergeFieldErrors } from '@/lib/forms';
import { Button, Callout, Field, RadioCards, Textarea, type Choice } from '@/ui';
import s from '../shared.module.css';
import {
  ACTION_SUBMIT,
  changeBlockedReason,
  changeGoesToAgent,
  firstApprovedOption,
  needsChangedValue,
  validateDecision,
  type DecisionForm,
} from './model';
import styles from './Review.module.css';

/**
 * Decisions (E16.F1.S3): approve one option, reject with a reason, change (sent back to the agent,
 * or the reviewer's answer for rule items) or dismiss. When the caller cannot decide, the form
 * stays visible but disabled, with the reason.
 */
export function DecisionPanel({
  project,
  item,
  onDecided,
}: {
  project: Project;
  item: ReviewItem;
  onDecided: (out: ReviewDecideOut) => void;
}) {
  const decide = useDecideReview(project.id);
  const reasonId = useId();
  const first = firstApprovedOption(item);
  const [f, setF] = useState<DecisionForm>({
    action: '',
    option: first ?? '',
    note: '',
    changedValue: '',
  });
  const [submitted, setSubmitted] = useState(false);
  const clientErrors = validateDecision(f, item);
  const errors = mergeFieldErrors(clientErrors, decide.error, submitted);
  const blocked = changeBlockedReason(item);
  const toAgent = changeGoesToAgent(item);
  const disabled = !item.can_resolve;
  const set = (patch: Partial<DecisionForm>) => setF((p) => ({ ...p, ...patch }));

  const actions: Choice<ReviewAction>[] = [
    {
      value: 'approve',
      label: 'Approve an option',
      description:
        item.options.length === 0
          ? 'This item has no options to approve.'
          : item.required_approvals > 1
            ? `Needs ${String(item.required_approvals)} approvals from different people${first ? `; the first chose “${first}”` : ''}.`
            : 'Resolves the item with the option you choose.',
      disabled: item.options.length === 0,
    },
    {
      value: 'reject',
      label: 'Reject',
      description: 'Closes the item as rejected, with your reason.',
    },
    {
      value: 'change',
      label: toAgent ? 'Request a change' : 'Change the answer',
      description:
        blocked ??
        (toAgent
          ? 'Sends your note back to the agent, which starts a follow-up run to revise its work.'
          : 'No agent raised this item: your changed answer becomes the decision.'),
      disabled: blocked !== null,
    },
    {
      value: 'dismiss',
      label: 'Dismiss',
      description: 'Not a real issue. Closes the item with your reason.',
    },
  ];

  const submit = () => {
    setSubmitted(true);
    if (Object.keys(clientErrors).length || !f.action) return;
    const body: ReviewDecideIn = { action: f.action, note: f.note.trim() };
    if (f.action === 'approve') body.option = f.option;
    if (f.action === 'change' && f.changedValue.trim()) body.changed_value = f.changedValue.trim();
    decide.mutate({ id: item.id, body }, { onSuccess: onDecided });
  };

  return (
    <section className={styles.section} aria-labelledby="review-decide">
      <h3 id="review-decide" className={styles.sectionTitle}>
        Decide
      </h3>
      {disabled ? (
        <Callout tone="info" title="You cannot decide this item">
          <span id={reasonId}>
            {item.cannot_resolve_reason ??
              `Only the ${item.owner_role_label} role${item.owner_user ? ` or ${item.owner_user}` : ''} decides this item.`}
          </span>
        </Callout>
      ) : null}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <fieldset
          className={styles.fieldset}
          disabled={disabled}
          aria-describedby={disabled ? reasonId : undefined}
        >
          <RadioCards
            legend="Decision"
            options={actions}
            value={f.action}
            onValueChange={(a) => set({ action: a })}
            error={errors.action}
          />
          {f.action === 'approve' ? (
            <RadioCards
              legend="Option"
              options={item.options.map((o) => ({
                value: o,
                label: o,
                ...(first && o !== first
                  ? {
                      disabled: true,
                      description: `The first approver chose “${first}”; approve the same option or reject the item.`,
                    }
                  : {}),
              }))}
              value={f.option}
              onValueChange={(o) => set({ option: o })}
              error={errors.option}
            />
          ) : null}
          {f.action === 'change' ? (
            <Field
              label={toAgent ? 'Suggested answer for the agent' : 'Changed answer'}
              help={
                needsChangedValue(item)
                  ? 'Required: this becomes the decision.'
                  : 'Optional: the agent gets it with your note.'
              }
              error={errors.changed_value}
              required={needsChangedValue(item)}
            >
              <Textarea
                rows={2}
                maxLength={4000}
                value={f.changedValue}
                onChange={(e) => set({ changedValue: e.target.value })}
              />
            </Field>
          ) : null}
          {f.action ? (
            <Field
              label={
                f.action === 'approve'
                  ? 'Note'
                  : f.action === 'change' && toAgent
                    ? 'Note for the agent'
                    : 'Reason'
              }
              help={
                f.action === 'approve'
                  ? 'Optional. Recorded with your approval.'
                  : 'Required, at least 10 characters. Recorded in the audit log.'
              }
              error={errors.note}
              required={f.action !== 'approve'}
            >
              <Textarea
                rows={3}
                maxLength={4000}
                value={f.note}
                onChange={(e) => set({ note: e.target.value })}
              />
            </Field>
          ) : null}
          <FormError error={decide.error} fields={['note', 'option', 'changed_value', 'action']} />
          <div className={s.row}>
            <Button
              type="submit"
              variant={f.action === 'reject' ? 'danger' : 'primary'}
              loading={decide.isPending}
            >
              {f.action ? ACTION_SUBMIT[f.action] : 'Record decision'}
            </Button>
            <span className={`${s.muted} ${s.xs}`}>
              Recorded with your name in the audit log. Agents never decide.
            </span>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
