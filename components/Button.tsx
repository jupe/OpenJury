import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps } from "react";

const baseClass = "app-button inline-flex min-h-12 max-w-full cursor-pointer items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50";
const buttonClass = `${baseClass} bg-indigo-600 text-white shadow-sm hover:bg-indigo-700 active:bg-indigo-800`;
const secondaryClass = `${baseClass} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 active:bg-slate-100`;

export default function Button({
  className = "",
  type = "button",
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" }) {
  return <button type={type} className={`${variant === "secondary" ? secondaryClass : buttonClass} ${className}`} {...props} />;
}

/** A navigation link that looks like a button. */
export function ButtonLink({ className = "", ...props }: ComponentProps<typeof Link>) {
  return <Link className={`${buttonClass} ${className}`} {...props} />;
}
