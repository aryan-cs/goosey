import type { HTMLAttributes, SVGProps } from "react";
import { Feather } from "lucide-react";

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
    <Feather aria-hidden="true" width="1em" height="1em" strokeWidth={1.8} {...props} className={["feather-icon", props.className].filter(Boolean).join(" ")} />
  );
}
