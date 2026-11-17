import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { IconButton } from './Button';
import { Tooltip } from './Tooltip';

export interface CopyButtonProps {
  value: string;
  /** Accessible name and tooltip, e.g. "Copy tenant ID". */
  label?: string;
  size?: 'sm' | 'md';
  className?: string;
}

/** Copies text to the clipboard and confirms with an icon change and a live announcement. */
export function CopyButton({ value, label = 'Copy', size = 'sm', className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error('Could not copy to the clipboard', {
        description: 'Your browser blocked clipboard access. Select the text and copy it manually.',
      });
    }
  }

  return (
    <>
      <Tooltip content={copied ? 'Copied' : label}>
        <IconButton
          label={label}
          size={size}
          className={className}
          icon={copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          onClick={() => void copy()}
        />
      </Tooltip>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </>
  );
}
