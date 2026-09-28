import { useState, type ReactNode } from 'react';
import { IconCheck, IconCopy } from './Icons';

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const onClick = async () => {
    await copyText(text);
    setDone(true);
    setTimeout(() => setDone(false), 1400);
  };
  if (label !== undefined) {
    return (
      <button type="button" className={className ?? 'btn btn-ghost btn-xs'} onClick={onClick}>
        {done ? <IconCheck width={13} height={13} /> : <IconCopy width={13} height={13} />} {done ? 'Copied' : label}
      </button>
    );
  }
  return (
    <button type="button" className={className ?? 'icon-btn'} onClick={onClick} title={done ? 'Copied' : 'Copy'} aria-label="Copy">
      {done ? <IconCheck className="foam" /> : <IconCopy />}
    </button>
  );
}

export function CodeBlock({ code, children }: { code: string; children?: ReactNode }) {
  return (
    <div className="codeblock">
      <pre>{children ?? code}</pre>
      <CopyButton text={code} label="Copy" className="btn btn-ghost btn-xs copy-float" />
    </div>
  );
}

/** A secret shown once (API key / node token) with a copy button. */
export function SecretBox({ value, note }: { value: string; note?: string }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="secret"><code>{value}</code><CopyButton text={value} label="Copy" /></div>
      <div className="tiny warn">{note ?? 'Copy it now — it will not be shown again.'}</div>
    </div>
  );
}
