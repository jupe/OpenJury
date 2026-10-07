import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps } from "react";

const shield = "M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3Z";
const person = "M10 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0";

const paths = {
  edit: "M16.9 3.6a2 2 0 0 1 2.8 2.8L8 18.1 4 19l.9-4L16.9 3.6Z",
  remove: "M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v6m4-6v6",
  save: "m5 12.5 4.5 4.5L19 7.5",
  cancel: "M6 6l12 12M18 6 6 18",
  admin: `${shield}m-3.5 8.5 2.5 2.5 4.5-4.5`,
  member: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0",
  promote: `${shield}M12 9v6m-3-3h6`,
  demote: `${shield}M9 12h6`,
  removeMember: `${person}M16 11h6`,
  invite: `${person}M19 8v6m-3-3h6`,
  pending: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
  copy: "M9 9h11v11H9ZM15 9V4H4v11h5",
  manage: "M4 6h9m4 0h3M15 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM4 12h3m4 0h9M9 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM4 18h11m4 0h1M17 16a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z",
  trophy: "M8 4h8v5a4 4 0 0 1-8 0V4ZM8 6H5v1a3 3 0 0 0 3 3m8-4h3v1a3 3 0 0 1-3 3m-4 3v4m-4 3h8",
  participant: "M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4",
  audience: "m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8L12 3Z",
  swap: "M4 7h16l-4-4M20 17H4l4 4",
  camera: "M4 8h3l2-3h6l2 3h3v11H4ZM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
  addImage: "M20 13v6H4V5h9M4 16l4.5-4.5 4 4 2-2L20 19M17 3v6m-3-3h6",
  signOut: "M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.5 9h17M3.5 15h17M12 3c2.3 2.5 3.5 5.5 3.5 9s-1.2 6.5-3.5 9c-2.3-2.5-3.5-5.5-3.5-9s1.2-6.5 3.5-9Z",
  chevronRight: "m9 6 6 6-6 6",
  addLink: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-.8.8M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l.8-.8",
  advance: "M4 12h16m-6-6 6 6-6 6",
  retry: "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1",
  disqualify: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM6 6l12 12",
  reinstate: "M9 4 4 9l5 5M4 9h10a6 6 0 0 1 0 12",
};

export type IconName = keyof typeof paths;

/** A decorative 20px line icon; give the surrounding control or image its accessible name. */
export function Icon({ name, className = "size-5" }: { name: IconName; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d={paths[name]} />
    </svg>
  );
}

const baseClass = "icon-button inline-flex size-12 shrink-0 cursor-pointer items-center justify-center rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50";

const tones = {
  neutral: "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
  danger: "text-red-700 hover:bg-red-50",
  primary: "bg-coral text-charcoal hover:bg-coral-hover active:bg-coral-active",
};

/** A compact square button showing only an icon. Requires an aria-label, also shown as a tooltip unless a title is given. */
export default function IconButton({
  icon,
  tone = "neutral",
  className = "",
  type = "button",
  title,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { "aria-label": string; icon: IconName; tone?: keyof typeof tones }) {
  return (
    <button
      type={type}
      title={title ?? props["aria-label"]}
      className={`${baseClass} ${tones[tone]} ${className}`}
      {...props}
    >
      <Icon name={icon} />
    </button>
  );
}

/** A navigation link that looks like an IconButton. Requires an aria-label, also shown as a tooltip. */
export function IconLink({
  icon,
  tone = "neutral",
  className = "",
  ...props
}: ComponentProps<typeof Link> & { "aria-label": string; icon: IconName; tone?: keyof typeof tones }) {
  return (
    <Link title={props["aria-label"]} className={`${baseClass} ${tones[tone]} ${className}`} {...props}>
      <Icon name={icon} />
    </Link>
  );
}
