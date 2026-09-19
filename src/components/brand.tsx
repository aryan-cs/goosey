import type { HTMLAttributes, SVGProps } from "react";

export function GooseMark({ title = "Goosey", className, ...props }: HTMLAttributes<HTMLSpanElement> & { title?: string }) {
  return (
    <span
      className={["goose-mark", className].filter(Boolean).join(" ")}
      role="img"
      aria-label={title}
      {...props}
    />
  );
}

export function FeatherIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="M20.4 3.6C13.2 2.8 6.1 7.1 5.5 14.2c-.2 2.2.3 4.2 1 5.8m0 0 3.1-6.3m-3.1 6.3-3 .7m6.1-7 7.3-4.1m-7.3 4.1 2.2 2.2m-2.2-2.2-.9-3.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
