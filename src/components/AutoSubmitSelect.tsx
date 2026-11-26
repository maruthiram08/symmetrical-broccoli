"use client";

import type { SelectHTMLAttributes } from "react";

/** A select that submits its form as soon as you pick something. */
export function AutoSubmitSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} onChange={(e) => e.currentTarget.form?.requestSubmit()} />;
}
