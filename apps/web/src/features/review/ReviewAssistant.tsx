import { Link } from '@tanstack/react-router';
import { Bot } from 'lucide-react';
import { useId, useState } from 'react';
import { useAskAssistant } from '@/api/runtime';
import type { Project, ReviewWorkbench } from '@/api/types';
import { FormError } from '@/app/FormError';
import { mergeFieldErrors } from '@/lib/forms';
import { Button, Callout, Field, StatusPill, Textarea, Timestamp, toast } from '@/ui';
import { runStatus } from '../runtime/model';
import s from '../shared.module.css';
import styles from './Review.module.css';

/**
 * The Review Assistant (E16.F1.S4): explains an item from its recorded evidence and precedents.
 * It has no tool that decides anything; its answer is the run's output, linked here.
 */
export function ReviewAssistant({ project, wb }: { project: Project; wb: ReviewWorkbench }) {
  const ask = useAskAssistant(project.id);
  const reasonId = useId();
  const [question, setQuestion] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const a = wb.assistant;
  const unavailable =
    a.unavailable_reason ??
    (a.can_ask ? null : 'You cannot ask the Review Assistant on this project.');
  const n = question.trim().length;
  const client =
    n < 5 ? { question: `Ask a question (at least 5 characters, ${String(n)} so far).` } : {};
  const errors = mergeFieldErrors<'question'>(client, ask.error, submitted);
  return (
    <section className={styles.section} aria-labelledby="review-assistant">
      <h3 id="review-assistant" className={styles.sectionTitle}>
        <span className={s.row}>
          <Bot aria-hidden="true" size={18} /> Review Assistant
        </span>
      </h3>
      <p className={`${s.small} ${s.muted}`}>
        Ask why the item was proposed. The assistant reads the item’s recorded evidence and earlier
        decisions on the same pattern; it does not see reviewers’ notes or sample values.{' '}
        <strong>It cannot approve, reject or change anything: you decide.</strong>
      </p>
      {unavailable ? (
        <Callout tone="warning" title="The Review Assistant is not available">
          <span id={reasonId}>{unavailable}</span>
        </Callout>
      ) : null}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (client.question) return;
          ask.mutate(
            { id: wb.item.id, question: question.trim() },
            {
              onSuccess: () => {
                toast.success('Question sent to the Review Assistant');
                setQuestion('');
                setSubmitted(false);
              },
            },
          );
        }}
      >
        <fieldset
          className={styles.fieldset}
          disabled={unavailable !== null}
          aria-describedby={unavailable ? reasonId : undefined}
        >
          <Field label="Your question" error={errors.question} help="5 to 2,000 characters.">
            <Textarea
              rows={2}
              maxLength={2000}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </Field>
          <FormError error={ask.error} fields={['question']} />
          <div>
            <Button type="submit" loading={ask.isPending}>
              Ask the assistant
            </Button>
          </div>
        </fieldset>
      </form>
      {wb.assistant_runs.length > 0 ? (
        <ul className={styles.plainList} aria-label="Questions asked">
          {[...wb.assistant_runs].reverse().map((r) => {
            const st = r.status ? runStatus(r.status) : null;
            return (
              <li key={r.run_id} className={styles.precedent}>
                <span className={styles.quote}>“{r.question}”</span>
                <span className={`${s.row} ${s.xs}`}>
                  {st ? (
                    <StatusPill tone={st.tone}>{st.label}</StatusPill>
                  ) : (
                    <StatusPill tone="neutral">Run not found</StatusPill>
                  )}
                  <span className={s.muted}>
                    {r.by} · <Timestamp value={r.at} />
                  </span>
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: project.id }}
                    search={{ tab: 'agents', agent_run: r.run_id }}
                  >
                    {r.status === 'succeeded' ? 'Read the answer' : 'Open the run transcript'}
                  </Link>
                </span>
                {r.status_detail ? (
                  <span className={`${s.muted} ${s.xs}`}>{r.status_detail}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
