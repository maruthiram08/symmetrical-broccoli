"use client";

/** A switch-style checkbox that submits its form as soon as it changes. */
export function SubmitOnChange({ name, defaultChecked }: { name: string; defaultChecked: boolean }) {
  return (
    <input
      className="db-switch"
      type="checkbox"
      role="switch"
      name={name}
      defaultChecked={defaultChecked}
      onChange={(e) => e.currentTarget.form?.requestSubmit()}
    />
  );
}
