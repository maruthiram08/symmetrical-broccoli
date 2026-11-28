import type { InputHTMLAttributes, ReactNode } from "react";

/** A labelled control. Pass an <input>/<select> as children, or use the input props directly. */
export function Field({
  label,
  hint,
  id,
  children,
  ...input
}: { label: string; hint?: string; id: string; children?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="db-field">
      <label className="db-field__label" htmlFor={id}>
        {label}
      </label>
      {children ?? <input className="db-input" id={id} {...input} />}
      {hint ? <span className="db-field__hint">{hint}</span> : null}
    </div>
  );
}
