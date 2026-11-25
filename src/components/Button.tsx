import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "highlight" | "secondary" | "ghost";

function cls(variant: Variant) {
  return variant === "secondary" ? "db-btn" : `db-btn db-btn--${variant}`;
}

export function Button({ variant = "primary", children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; children: ReactNode }) {
  return (
    <button className={cls(variant)} {...rest}>
      {children}
    </button>
  );
}

/** A link styled as a pill button. Uses a plain <a> for API routes and external URLs. */
export function ButtonLink({ href, variant = "primary", children }: { href: string; variant?: Variant; children: ReactNode }) {
  if (href.startsWith("/api/") || /^https?:/.test(href)) {
    return (
      <a className={cls(variant)} href={href}>
        {children}
      </a>
    );
  }
  return (
    <Link className={cls(variant)} href={href}>
      {children}
    </Link>
  );
}
