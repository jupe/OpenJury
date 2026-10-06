import Link from "next/link";
import { useLocale } from "@/lib/i18n";

export type Crumb = { label: string; href?: string };

/** Where the current page sits: Dashboard › Group › Competition › Admin. */
export default function Breadcrumbs({ items }: { items: Crumb[] }) {
  const { t } = useLocale();
  return (
    <nav aria-label={t("Breadcrumb")}>
      <ol className="flex flex-wrap items-center gap-x-1 text-sm text-slate-600">
        {items.map((item, index) => (
          <li key={index} className="flex min-w-0 items-center gap-x-1">
            {index > 0 && <span aria-hidden="true">›</span>}
            {item.href ? (
              <Link href={item.href} className="flex min-h-11 min-w-0 items-center break-words px-1 underline hover:text-indigo-700">
                {item.label}
              </Link>
            ) : (
              <span aria-current="page" className="min-w-0 break-words px-1 font-semibold text-slate-900">{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
