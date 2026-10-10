"use client";

import Button from "@/components/Button";
import Card from "@/components/Card";
import { useLocale } from "@/lib/i18n";
import { useState } from "react";

type Winner = { rank: number; creator_id: string; creator_name: string; is_disqualified: boolean };

const places = [1, 2, 3] as const;

function placeName(rank: number, t: ReturnType<typeof useLocale>["t"]) {
  if (rank === 1) return t("First place");
  if (rank === 2) return t("Second place");
  return t("Third place");
}

function AwardSeal() {
  return (
    <svg className="award-certificate-seal" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d="M29 67c-13-14-8-34 5-42-2 12 2 21 10 28M71 67c13-14 8-34-5-42 2 12-2 21-10 28M35 72c11 5 19 5 30 0" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path d="m50 29 3.8 8 8.8 1.3-6.3 6.2 1.5 8.8-7.8-4.1-7.8 4.1 1.5-8.8-6.3-6.2 8.8-1.3z" fill="currentColor" />
      <circle cx="27" cy="31" r="2" fill="currentColor" />
      <circle cx="73" cy="31" r="2" fill="currentColor" />
    </svg>
  );
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

async function downloadCertificates(type: "templates" | "winners", competitionName: string) {
  document.body.classList.add(`download-award-${type}`);
  try {
    const { default: html2pdf } = await import("html2pdf.js");
    const section = document.querySelector<HTMLElement>(`.${type === "templates" ? "template-certificates" : "winner-certificates"}`);
    if (!section) return;
    const safeName = competitionName.trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 70) || "competition";
    await html2pdf().set({
      filename: `openjury-${safeName}-${type === "templates" ? "certificate-templates" : "winner-certificates"}.pdf`,
      margin: 0,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff",
        onclone: (clonedDocument: Document) => {
          const clonedSection = clonedDocument.querySelector<HTMLElement>(
            `.${type === "templates" ? "template-certificates" : "winner-certificates"}`,
          );
          if (clonedSection) {
            clonedSection.style.display = "block";
            clonedSection.style.position = "static";
            clonedSection.style.opacity = "1";
            clonedSection.style.width = "210mm";
          }
        },
      },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
    }).from(section).save();
  } finally {
    document.body.classList.remove("download-award-templates", "download-award-winners");
  }
}

export default function WinnerCertificates({
  competitionName,
  competitionStatus,
  published,
  isAdmin,
  userId,
  organizerFirstNames,
  winners,
}: {
  competitionName: string;
  competitionStatus: string;
  published: boolean;
  isAdmin: boolean;
  userId: string;
  organizerFirstNames: string[];
  winners: Winner[];
}) {
  const { t } = useLocale();
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const printableWinners = published
    ? winners.filter((winner) => winner.rank >= 1 && winner.rank <= 3
      && !winner.is_disqualified && (isAdmin || winner.creator_id === userId))
    : [];
  const canPrintTemplates = isAdmin && ["draft", "submission", "voting"].includes(competitionStatus);
  const canPrint = canPrintTemplates || printableWinners.length > 0;

  async function download(type: "templates" | "winners") {
    setDownloading(true);
    setDownloadError("");
    try {
      await downloadCertificates(type, competitionName);
    } catch {
      setDownloadError(t("Unable to download certificate PDF. Please try again."));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      {canPrint && (
        <Card title={t("Award certificates")}>
          <div className="flex flex-wrap gap-3">
            {canPrintTemplates && (
              <>
                <Button variant="secondary" onClick={() => printCertificates("templates")}>
                  {t("Print blank certificate templates")}
                </Button>
                <Button variant="secondary" disabled={downloading} onClick={() => void download("templates")}>
                  {t("Download blank certificate templates")}
                </Button>
              </>
            )}
            {printableWinners.length > 0 && (
              <>
                <Button onClick={() => printCertificates("winners")}>
                  {t(isAdmin ? "Print published winner certificates" : "Print my winner certificate")}
                </Button>
                <Button variant="secondary" disabled={downloading} onClick={() => void download("winners")}>
                  {t(isAdmin ? "Download published winner certificates" : "Download my winner certificate")}
                </Button>
              </>
            )}
          </div>
          <p className="mt-3 text-sm text-slate-600">{t("Download a PDF or use your browser’s print dialog.")}</p>
          {downloadError && <p role="alert" className="mt-2 text-sm text-red-700">{downloadError}</p>}
        </Card>
      )}
      {canPrintTemplates && (
        <section className="certificate-print template-certificates" aria-label={t("Print blank certificate templates")}>
          {places.map((rank) => (
            <article className="award-certificate" key={rank}>
              <div className="award-certificate-frame">
                <span className="award-certificate-corner award-certificate-corner-top-left" aria-hidden="true">❦</span>
                <span className="award-certificate-corner award-certificate-corner-top-right" aria-hidden="true">❦</span>
                <span className="award-certificate-corner award-certificate-corner-bottom-left" aria-hidden="true">❦</span>
                <span className="award-certificate-corner award-certificate-corner-bottom-right" aria-hidden="true">❦</span>
                <p className="award-certificate-brand">OPENJURY</p>
                <p className="award-certificate-kicker">{t("Certificate of achievement")}</p>
                <h1>{t("Award Certificate")}</h1>
                <p className="award-certificate-intro">{t("This certificate is proudly presented to")}</p>
                <p className="award-certificate-recipient">&nbsp;</p>
                <p className="award-certificate-description">{t("In recognition of an outstanding achievement")}</p>
                <p className={`award-certificate-place award-certificate-place-${rank}`}>
                  {placeName(rank, t)}
                </p>
                <p className="award-certificate-competition">{competitionName}</p>
                <div className="award-certificate-signatures">
                  <div className="award-certificate-signature">
                    <p className="award-certificate-organizer-names">
                      {organizerFirstNames.map((name, index) => <span key={`${name}:${index}`}>{name}</span>)}
                    </p>
                    <span>{t("Competition organizers")}</span>
                  </div>
                  <div className="award-certificate-date"><AwardSeal /><p>{t("Awarded on")}</p></div>
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
                <span className="award-certificate-corner award-certificate-corner-top-left" aria-hidden="true">❦</span>
                <span className="award-certificate-corner award-certificate-corner-top-right" aria-hidden="true">❦</span>
                <span className="award-certificate-corner award-certificate-corner-bottom-left" aria-hidden="true">❦</span>
                <span className="award-certificate-corner award-certificate-corner-bottom-right" aria-hidden="true">❦</span>
                <p className="award-certificate-brand">OPENJURY</p>
                <p className="award-certificate-kicker">{t("Certificate of achievement")}</p>
                <h1>{t("Award Certificate")}</h1>
                <p className="award-certificate-intro">{t("This certificate is proudly presented to")}</p>
                <p className="award-certificate-recipient">{winner.creator_name || t("Participant")}</p>
                <p className="award-certificate-description">{t("In recognition of an outstanding achievement")}</p>
                <p className={`award-certificate-place award-certificate-place-${winner.rank}`}>
                  {placeName(winner.rank, t)}
                </p>
                <p className="award-certificate-competition">{competitionName}</p>
                <div className="award-certificate-signatures">
                  <div className="award-certificate-signature">
                    <p className="award-certificate-organizer-names">
                      {organizerFirstNames.map((name, index) => <span key={`${name}:${index}`}>{name}</span>)}
                    </p>
                    <span>{t("Competition organizers")}</span>
                  </div>
                  <div className="award-certificate-date"><AwardSeal /><p>{t("Awarded on")}</p></div>
                </div>
              </div>
            </article>
          ))}
        </section>
      )}
    </>
  );
}
