"use client";

import type { ReactNode } from "react";
import { useLocale } from "@/lib/i18n";

export type PodiumPlace = 1 | 2 | 3;

export type PodiumSpot = {
  key: string;
  /** Tied results share a place, so this need not match the spot's position. */
  place: PodiumPlace;
  name: string;
  detail?: ReactNode;
};

export const PODIUM_PLACES = {
  1: { label: "1st place", medal: "bg-amber-400 text-amber-950", height: "h-28" },
  2: { label: "2nd place", medal: "bg-slate-300 text-slate-900", height: "h-20" },
  3: { label: "3rd place", medal: "bg-orange-400 text-orange-950", height: "h-14" },
} as const;

/** Up to three spots in finishing order, shown left to right as 2nd, 1st, 3rd. */
export default function Podium({ label, spots }: { label: string; spots: PodiumSpot[] }) {
  const { t } = useLocale();
  const slots = [1, 0, 2].map((index) => spots[index]).filter(Boolean);
  return (
    <ol aria-label={label} className="flex items-end justify-center gap-3 pt-2">
      {slots.map((spot) => {
        const place = PODIUM_PLACES[spot.place];
        return (
          <li key={spot.key} className="flex w-full max-w-36 flex-col items-center gap-1 text-center">
            <span aria-hidden className={`inline-flex size-10 items-center justify-center rounded-full text-lg font-bold shadow ${place.medal}`}>{spot.place}</span>
            <span className="w-full break-words text-sm font-semibold text-slate-900">{spot.name}</span>
            {spot.detail && <span className="w-full break-words text-xs text-slate-500">{spot.detail}</span>}
            <div className={`flex w-full items-start justify-center rounded-t-lg pt-2 text-xs font-semibold ${place.medal} ${place.height}`}>{t(place.label)}</div>
          </li>
        );
      })}
    </ol>
  );
}
