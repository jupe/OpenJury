import type { ReactNode } from "react";

export default function Card({
  id,
  title,
  action,
  children,
}: {
  /** Optional anchor target; the card leaves room for the header when scrolled to. */
  id?: string;
  title: ReactNode;
  /** Optional control shown next to the title, such as an add button. */
  action?: ReactNode;
  /** Omit for a title-only card. */
  children?: ReactNode;
}) {
  const heading = <h2 className="text-xl font-semibold tracking-tight">{title}</h2>;
  return (
    <section id={id} className="app-card min-w-0 scroll-mt-24 space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      {action ? (
        <div className="flex items-center justify-between gap-3">{heading}{action}</div>
      ) : heading}
      {children != null && children !== false && <div className="space-y-4 text-slate-600">{children}</div>}
    </section>
  );
}
