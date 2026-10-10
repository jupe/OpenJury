"use client";

import Button from "@/components/Button";
import Card from "@/components/Card";
import { useLocale } from "@/lib/i18n";

type Winner = { rank: number; creator_id: string; creator_name: string; is_disqualified: boolean };

const places = [1, 2, 3] as const;

function placeName(rank: number, t: ReturnType<typeof useLocale>["t"]) {
  if (rank === 1) return t("First place");
  if (rank === 2) return t("Second place");
  return t("Third place");
}

function printCertificates(type: "templates" | "winners") {
  document.body.classList.add("print-award-certificates");
  document.body.classList.add(`print-award-${type}`);
  const cleanup = () => document.body.classList.remove("print-award-certificates", "print-award-templates", "print-award-winners");
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
  isAdmin,
  userId,
  winners,
}: {
  competitionName: string;
  published: boolean;
  isAdmin: boolean;
  userId: string;
  winners: Winner[];
}) {
  const { t } = useLocale();
  const printableWinners = published
    ? winners.filter((winner) => winner.rank >= 1 && winner.rank <= 3
      && !winner.is_disqualified && (isAdmin || winner.creator_id === userId))
    : [];
  const canPrint = isAdmin || printableWinners.length > 0;

  return (
    <>
      {canPrint && (
        <Card title={t("Award certificates")}>
          <div className="flex flex-wrap gap-3">
            {isAdmin && (
              <Button variant="secondary" onClick={() => printCertificates("templates")}>
                {t("Print blank certificate templates")}
              </Button>
            )}
            {printableWinners.length > 0 && (
              <Button onClick={() => printCertificates("winners")}>
                {t(isAdmin ? "Print published winner certificates" : "Print my winner certificate")}
              </Button>
            )}
          </div>
          <p className="mt-3 text-sm text-slate-600">{t("Use your browser’s print dialog to print or save the certificates as PDF.")}</p>
        </Card>
      )}
      {isAdmin && (
        <section className="certificate-print template-certificates" aria-label={t("Print blank certificate templates")}>
          {places.map((rank) => (
            <article className="award-certificate" key={rank}>
              <div className="award-certificate-frame">
                <p className="award-certificate-brand">OPENJURY</p>
                <p className="award-certificate-kicker">{t("Certificate of achievement")}</p>
                <h1>{t("Certificate of Honor")}</h1>
                <p className="award-certificate-intro">{t("This certificate is proudly presented to")}</p>
                <p className="award-certificate-recipient">&nbsp;</p>
                <p className="award-certificate-description">{t("In recognition of an outstanding achievement")}</p>
                <p className={`award-certificate-place award-certificate-place-${rank}`}>
                  {placeName(rank, t)}
                </p>
                <p className="award-certificate-competition">{competitionName}</p>
                <div className="award-certificate-signatures">
                  <p><span>{t("Awarded on")}</span></p>
                  <p><span>{t("Competition organizer")}</span></p>
                </div>
              </div>
            </article>
          ))}
        </section>
      )}
      {printableWinners.length > 0 && (
        <section className="certificate-print winner-certificates" aria-label={t("Print published winner certificates")}>
          {printableWinners.map((winner, index) => (
            <article className="award-certificate" key={`${winner.rank}:${index}`}>
              <div className="award-certificate-frame">
                <p className="award-certificate-brand">OPENJURY</p>
                <p className="award-certificate-kicker">{t("Certificate of achievement")}</p>
                <h1>{t("Certificate of Honor")}</h1>
                <p className="award-certificate-intro">{t("This certificate is proudly presented to")}</p>
                <p className="award-certificate-recipient">{winner.creator_name || t("Participant")}</p>
                <p className="award-certificate-description">{t("In recognition of an outstanding achievement")}</p>
                <p className={`award-certificate-place award-certificate-place-${winner.rank}`}>
                  {placeName(winner.rank, t)}
                </p>
                <p className="award-certificate-competition">{competitionName}</p>
                <div className="award-certificate-signatures">
                  <p><span>{t("Awarded on")}</span></p>
                  <p><span>{t("Competition organizer")}</span></p>
                </div>
              </div>
            </article>
          ))}
        </section>
      )}
    </>
  );
}
