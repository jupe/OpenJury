"use client";

import Button from "@/components/Button";
import Card from "@/components/Card";
import { useLocale } from "@/lib/i18n";

type Winner = { rank: number; creator_name: string; is_disqualified: boolean };

const places = [1, 2, 3] as const;

function placeName(rank: number, t: ReturnType<typeof useLocale>["t"]) {
  if (rank === 1) return t("First place");
  if (rank === 2) return t("Second place");
  return t("Third place");
}

function printCertificates() {
  document.body.classList.add("print-award-certificates");
  const cleanup = () => document.body.classList.remove("print-award-certificates");
  window.addEventListener("afterprint", cleanup, { once: true });
  try {
    window.print();
  } catch (error) {
    cleanup();
    throw error;
  }
}

export default function WinnerCertificates({
  competitionName,
  published,
  winners,
}: {
  competitionName: string;
  published: boolean;
  winners: Winner[];
}) {
  const { t } = useLocale();
  const printableWinners = published
    ? winners.filter((winner) => winner.rank >= 1 && winner.rank <= 3 && !winner.is_disqualified)
    : [];

  return (
    <>
      <Card title={t("Award certificates")}>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => printCertificates()}>
            {t("Print blank certificate templates")}
          </Button>
          {published && printableWinners.length > 0 && (
            <Button onClick={() => printCertificates()}>
              {t("Print published winner certificates")}
            </Button>
          )}
        </div>
        <p className="mt-3 text-sm text-slate-600">{t("Use your browser’s print dialog to print or save the certificates as PDF.")}</p>
      </Card>
      <section className="certificate-print" aria-label={t("Award certificates")}>
        {(printableWinners.length
          ? printableWinners.map((winner) => ({ rank: winner.rank, name: winner.creator_name }))
          : places.map((rank) => ({ rank, name: "" }))
        ).map(({ rank, name }, index) => (
          <article className="award-certificate" key={`${rank}:${index}`}>
            <div className="award-certificate-frame">
              <p className="award-certificate-brand">OPENJURY</p>
              <p className="award-certificate-kicker">{t("Certificate of achievement")}</p>
              <h1>{t("Certificate of Honor")}</h1>
              <p className="award-certificate-intro">{t("This certificate is proudly presented to")}</p>
              <p className={`award-certificate-recipient ${name ? "" : "award-certificate-blank"}`}>
                {name || "\u00a0"}
              </p>
              <p className="award-certificate-description">{t("In recognition of an outstanding achievement")}</p>
              <p className={`award-certificate-place award-certificate-place-${rank}`}>
                {placeName(rank, t)}
              </p>
              <p className="award-certificate-competition">{competitionName}</p>
              <div className="award-certificate-signatures">
                <p><span>{name ? t("Awarded on") : "\u00a0"}</span></p>
                <p><span>{t("Competition organizer")}</span></p>
              </div>
            </div>
          </article>
        ))}
      </section>
    </>
  );
}
