import { ShieldAlert } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import { useScreenText } from '@/api/agents';
import { FormError } from '@/app/FormError';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Field,
  PlainText,
  Input,
  StatusPill,
  Textarea,
} from '@/ui';
import s from '../shared.module.css';

/** Screen a piece of text the way legacy data is screened before an agent sees it. Nothing is stored. */
export function GuardrailLab() {
  const screen = useScreenText();
  const [text, setText] = useState('');
  const [source, setSource] = useState('lab');
  const [error, setError] = useState<string | null>(null);
  const r = screen.data;

  function submit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!text.trim()) {
      setError('Paste some text to screen.');
      return;
    }
    setError(null);
    screen.mutate({ text, source: source.trim() || 'lab' });
  }

  return (
    <div className={s.stack}>
      <Card aria-labelledby="lab-title">
        <CardHeader
          titleId="lab-title"
          title="Guardrail lab"
          description="Paste text as it might appear in legacy data. See what the screening finds and exactly how the text would reach an agent: wrapped and labelled as data, never as instructions. Nothing is stored."
        />
        <CardBody>
          <form onSubmit={submit} noValidate className={s.stack}>
            <Field label="Text to screen" error={error ?? undefined} required>
              <Textarea
                rows={6}
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={20000}
              />
            </Field>
            <Field label="Source label" help="Shown to the agent as where the text came from.">
              <Input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                maxLength={200}
                style={{ maxWidth: '20rem' }}
              />
            </Field>
            <div>
              <Button
                type="submit"
                variant="primary"
                leadingIcon={<ShieldAlert aria-hidden="true" />}
                loading={screen.isPending}
              >
                Screen text
              </Button>
            </div>
            <FormError error={screen.error} fields={['text', 'source']} />
          </form>
        </CardBody>
      </Card>
      {r ? (
        <Card aria-labelledby="lab-result" aria-live="polite">
          <CardHeader
            titleId="lab-result"
            title="Result"
            actions={
              r.flagged ? (
                <StatusPill tone="danger">Flagged{r.severity ? ` · ${r.severity}` : ''}</StatusPill>
              ) : (
                <StatusPill tone="success">Not flagged</StatusPill>
              )
            }
          />
          <CardBody className={s.stack}>
            {r.hidden_characters > 0 ? (
              <Callout
                tone="warning"
                title={`${r.hidden_characters} hidden character${r.hidden_characters === 1 ? '' : 's'}`}
              >
                The text contains characters a person would not see. They are shown below.
              </Callout>
            ) : null}
            {r.findings.length > 0 ? (
              <section aria-label="Findings">
                <h3 className={s.cellPrimary} style={{ marginBottom: 'var(--space-2)' }}>
                  Findings ({r.findings.length})
                </h3>
                <ul style={{ listStyle: 'none' }} className={s.stackSm}>
                  {r.findings.map((f, i) => (
                    <li key={i} className={s.cellStack}>
                      <span className={s.row}>
                        <Badge tone={f.severity === 'high' ? 'danger' : 'warning'}>
                          {f.severity}
                        </Badge>
                        <strong>{f.label}</strong>
                        <span className={`${s.muted} ${s.xs}`}>{f.rule}</span>
                        {f.encoded ? <Badge>encoded</Badge> : null}
                      </span>
                      <PlainText>{f.excerpt}</PlainText>
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              <p className={s.muted}>No instruction-like content was found.</p>
            )}
            <section aria-label="Visible text">
              <h3 className={s.cellPrimary} style={{ marginBottom: 'var(--space-2)' }}>
                The text with hidden characters revealed
              </h3>
              <PlainText>{r.visible_text}</PlainText>
            </section>
            <section aria-label="How the agent receives it">
              <h3 className={s.cellPrimary} style={{ marginBottom: 'var(--space-2)' }}>
                How the text reaches an agent
              </h3>
              <PlainText>{r.wrapped}</PlainText>
            </section>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
