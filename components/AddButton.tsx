import type { ButtonHTMLAttributes } from "react";

/** A compact round "+" button for adding an item to a card's list. Requires an aria-label. */
export default function AddButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { "aria-label": string }) {
  return (
    <button
      type="button"
      title={props["aria-label"]}
      className={`inline-flex size-12 shrink-0 cursor-pointer items-center justify-center rounded-full bg-indigo-600 text-2xl leading-none text-white hover:bg-indigo-700 active:bg-indigo-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      {...props}
    >
      <span aria-hidden="true">+</span>
    </button>
  );
}
