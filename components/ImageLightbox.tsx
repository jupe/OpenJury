"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/lib/i18n";

export type GalleryImage = { key: string; url: string };

const roundButton = "flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full bg-black/50 text-2xl leading-none text-white hover:bg-black/70 disabled:cursor-default disabled:opacity-30";

/** Full-screen image carousel opened on `start`: swipe, arrow keys, or the buttons move between images. */
export default function ImageLightbox({ images, label, start, onClose }: {
  images: GalleryImage[];
  label: string;
  start: number;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(start);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    const slides = track.current;
    if (slides) slides.scrollTo({ left: start * slides.clientWidth, behavior: "instant" });
    // Keep the page behind the gallery from scrolling.
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    // Unmounting removes the dialog; closing it here would fire onClose and reopen loops in dev.
    return () => { root.style.overflow = overflow; };
  }, [start]);

  function go(target: number) {
    const slides = track.current;
    if (!slides) return;
    const next = Math.max(0, Math.min(images.length - 1, target));
    slides.scrollTo({ left: next * slides.clientWidth, behavior: "smooth" });
  }

  return (
    <dialog
      ref={dialog}
      aria-label={`${label} ${t("gallery")}`}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") go(index + 1);
        if (event.key === "ArrowLeft") go(index - 1);
      }}
      className="m-0 h-dvh max-h-none w-screen max-w-none bg-slate-950 p-0 text-white backdrop:bg-black/80"
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <p aria-live="polite" className="pl-1 text-sm tabular-nums">{index + 1} / {images.length}</p>
          <button type="button" autoFocus aria-label={t("Close gallery")} onClick={() => dialog.current?.close()} className={roundButton}>
            ×
          </button>
        </div>
        <div className="relative min-h-0 flex-1">
          <div
            ref={track}
            onScroll={(event) => {
              const { scrollLeft, clientWidth } = event.currentTarget;
              if (clientWidth) setIndex(Math.round(scrollLeft / clientWidth));
            }}
            className="flex h-full snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none]"
          >
            {images.map(({ key, url }, slide) => (
              <div key={key} className="flex h-full w-full shrink-0 snap-center items-center justify-center p-2 sm:px-16">
                <Image
                  src={url}
                  alt={`${label} ${slide + 1}, full view`}
                  width={1024}
                  height={1024}
                  unoptimized
                  className="h-full w-full object-contain"
                />
              </div>
            ))}
          </div>
          {images.length > 1 && (
            <>
              <button type="button" aria-label={t("Previous image")} disabled={index === 0} onClick={() => go(index - 1)} className={`${roundButton} absolute top-1/2 left-2 -translate-y-1/2`}>
                ‹
              </button>
              <button type="button" aria-label={t("Next image")} disabled={index === images.length - 1} onClick={() => go(index + 1)} className={`${roundButton} absolute top-1/2 right-2 -translate-y-1/2`}>
                ›
              </button>
            </>
          )}
        </div>
        {images.length > 1 && (
          <ul className="flex justify-center gap-2 overflow-x-auto px-3 py-3">
            {images.map(({ key, url }, slide) => (
              <li key={key} className="shrink-0">
                <button
                  type="button"
                  aria-label={`${t("Show image")} ${slide + 1}`}
                  aria-current={slide === index}
                  onClick={() => go(slide)}
                  className={`block cursor-pointer overflow-hidden rounded-md border-2 ${slide === index ? "border-white" : "border-transparent opacity-60 hover:opacity-100"}`}
                >
                  <Image src={url} alt="" width={56} height={56} unoptimized className="h-12 w-12 object-cover" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </dialog>
  );
}
