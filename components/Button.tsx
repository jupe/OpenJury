import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps } from "react";

const buttonClass = "app-button inline-flex min-h-12 max-w-full cursor-pointer items-center justify-center rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 active:bg-indigo-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50";

export default function Button({
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={`${buttonClass} ${className}`} {...props} />;
}

/** A navigation link that looks like a button. */
export function ButtonLink({ className = "", ...props }: ComponentProps<typeof Link>) {
  return <Link className={`${buttonClass} ${className}`} {...props} />;
}
