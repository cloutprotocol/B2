import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

// The page-level states: loading, and a failure with a way out. Centered, in words, with a Retry that
// spins while it tries; pages keep polling underneath, so a busy RPC clears up on its own too.

export function Loading({ text }: { text: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="state-spin" aria-hidden />
      <p>{text}</p>
    </div>
  );
}

export function Retry({ title, message, onRetry, busy, retryable = true, children }: { title: string; message: string; onRetry: () => void; busy?: boolean; retryable?: boolean; children?: ReactNode }) {
  return (
    <div className="state" role="alert">
      <span className="state-icon" aria-hidden>
        <svg viewBox="0 0 24 24" width="22" height="22">
          <path d="M12 8v5M12 16.5v.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </span>
      <h2>{title}</h2>
      <p>{message}</p>
      <div className="state-actions">
        <button type="button" className="state-retry" onClick={onRetry} disabled={busy}>
          {busy ? <span className="state-spin is-sm" aria-hidden /> : null}
          {busy ? 'Trying…' : 'Retry'}
        </button>
        {children}
      </div>
      {retryable ? <small>Retrying automatically in the background.</small> : null}
    </div>
  );
}

/** A link back to the scanner, for a page whose token doesn't exist. */
export const ToScanner = () => (
  <Link to="/scan" className="state-link">
    Open the scanner
  </Link>
);
