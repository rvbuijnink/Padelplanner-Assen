// E-mail versturen voor de Padelplanner. Drie mogelijkheden (de eerste die volledig is ingesteld wordt gebruikt):
// - Brevo: BREVO_API_KEY en MAIL_AFZENDER (een in Brevo geverifieerd afzenderadres).
// - Gmail (of andere SMTP): SMTP_USER (je Gmail-adres) en SMTP_PASS (een app-wachtwoord). Gratis, tot ~500 mails per dag.
//   Optioneel SMTP_HOST/SMTP_PORT voor een andere mailprovider (standaard smtp.gmail.com:465).
// - Resend: RESEND_API_KEY en MAIL_AFZENDER.
// Zonder instellingen worden er geen e-mails verstuurd; de site blijft gewoon werken (uitnodigingen staan ook op de site).
// Tussen 22:00 en 08:00 (Nederlandse tijd) gaan er geen e-mails uit: die komen in een wachtrij en gaan om 08:00 de deur uit.
import nodemailer from "nodemailer";
import { asc, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { mailWachtrij } from "../db/schema.js";

// Bijlage als tekst (bijv. een agenda-afspraak .ics).
export type Bijlage = { naam: string; inhoud: string; type: string };
export type Mail = { aan: string; naam?: string; onderwerp: string; tekst: string; knoppen?: { label: string; url: string }[]; bijlagen?: Bijlage[] };

const env = (k: string): string | undefined => (globalThis as any).Netlify?.env?.get(k) ?? process.env[k];

const brevoAan = () => !!(env("BREVO_API_KEY") && env("MAIL_AFZENDER"));
const smtpAan = () => !brevoAan() && !!(env("SMTP_USER") && env("SMTP_PASS"));
const resendAan = () => !!(env("RESEND_API_KEY") && env("MAIL_AFZENDER"));
export const mailAan = () => brevoAan() || smtpAan() || resendAan();
// Welke verzendmanier nu wordt gebruikt (voor de testmail).
export const mailManier = () => (brevoAan() ? "Brevo" : smtpAan() ? "Gmail/SMTP" : resendAan() ? "Resend" : null);

let smtp: ReturnType<typeof nodemailer.createTransport> | null = null;
function smtpTransport() {
  if (!smtp) {
    const port = Number(env("SMTP_PORT") || 465);
    smtp = nodemailer.createTransport({
      host: env("SMTP_HOST") || "smtp.gmail.com",
      port,
      secure: port === 465,
      auth: { user: env("SMTP_USER")!, pass: env("SMTP_PASS")!.replace(/\s+/g, "") },
      connectionTimeout: 10000,
    });
  }
  return smtp;
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function html(m: Mail) {
  const alinea = m.tekst.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const knoppen = (m.knoppen ?? [])
    .map((k, i) => `<a href="${esc(k.url)}" style="display:inline-block;margin:4px 8px 4px 0;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600;${i === 0 ? "background:#c6f432;color:#0b2545" : "background:#eef2f7;color:#0b2545"}">${esc(k.label)}</a>`)
    .join("");
  return `<!doctype html><html><body style="margin:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;color:#13233a">
<div style="max-width:560px;margin:0 auto;padding:24px">
<div style="background:#0b2545;color:#fff;border-radius:14px 14px 0 0;padding:16px 22px;font-weight:700;font-size:18px">Padelplanner Assen</div>
<div style="background:#fff;border-radius:0 0 14px 14px;padding:22px;line-height:1.5;font-size:15px">${alinea}${knoppen ? `<div style="margin-top:8px">${knoppen}</div>` : ""}</div>
<p style="font-size:12px;color:#6b7a90;margin:14px 4px">Je krijgt deze e-mail omdat je meedoet aan de Padelplanner. Geen e-mails meer? Zet het uit bij Vaste instellingen.</p>
</div></body></html>`;
}

const platteTekst = (m: Mail) => m.tekst + (m.knoppen?.length ? "\n\n" + m.knoppen.map((k) => `${k.label}: ${k.url}`).join("\n") : "");

async function verstuurEen(m: Mail) {
  if (smtpAan()) {
    const afzender = env("MAIL_AFZENDER") || env("SMTP_USER")!;
    await smtpTransport().sendMail({
      from: { name: "Padelplanner Assen", address: afzender },
      to: m.naam ? { name: m.naam, address: m.aan } : m.aan,
      subject: m.onderwerp,
      html: html(m),
      text: platteTekst(m),
      attachments: (m.bijlagen ?? []).map((b) => ({ filename: b.naam, content: b.inhoud, contentType: b.type })),
    });
    return;
  }
  const afzender = env("MAIL_AFZENDER")!;
  const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64");
  const bijlagen = m.bijlagen ?? [];
  const brevo = brevoAan() ? env("BREVO_API_KEY") : undefined;
  const r = brevo
    ? await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": brevo, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sender: { name: "Padelplanner Assen", email: afzender },
          to: [{ email: m.aan, ...(m.naam ? { name: m.naam } : {}) }],
          subject: m.onderwerp,
          htmlContent: html(m),
          textContent: platteTekst(m),
          ...(bijlagen.length ? { attachment: bijlagen.map((b) => ({ name: b.naam, content: b64(b.inhoud) })) } : {}),
        }),
        signal: AbortSignal.timeout(10000),
      })
    : await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${env("RESEND_API_KEY")}`, "content-type": "application/json" },
        body: JSON.stringify({ from: `Padelplanner Assen <${afzender}>`, to: [m.aan], subject: m.onderwerp, html: html(m), text: platteTekst(m),
          ...(bijlagen.length ? { attachments: bijlagen.map((b) => ({ filename: b.naam, content: b64(b.inhoud) })) } : {}) }),
        signal: AbortSignal.timeout(10000),
      });
  if (!r.ok) throw new Error(`E-mail versturen mislukt: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}

// Nederlandse tijd in minuten sinds middernacht.
export function nlMinuten(ms = Date.now()) {
  const [u, m] = new Date(ms).toLocaleTimeString("en-GB", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit", hour12: false }).split(":").map(Number);
  return (u % 24) * 60 + m;
}
export const STIL_VAN = 22 * 60, STIL_TOT = 8 * 60;
export const isStil = (ms = Date.now()) => { const m = nlMinuten(ms); return m >= STIL_VAN || m < STIL_TOT; };

// Verstuurt alle mails; een mislukte mail houdt de rest niet tegen. 's Nachts gaan ze in de wachtrij.
export async function verstuur(mails: Mail[]) {
  if (!mails.length) return;
  if (isStil()) {
    await db.insert(mailWachtrij).values(mails.map((m) => ({ mail: m })));
    console.log(`Stille uren: ${mails.length} e-mail(s) in de wachtrij tot 08:00.`);
    return;
  }
  await verstuurNu(mails);
}

// Na 08:00: alles uit de wachtrij versturen.
export async function verstuurWachtrij() {
  if (isStil()) return 0;
  const rijen = await db.select().from(mailWachtrij).orderBy(asc(mailWachtrij.id)).limit(200);
  if (!rijen.length) return 0;
  await db.delete(mailWachtrij).where(inArray(mailWachtrij.id, rijen.map((r) => r.id)));
  await verstuurNu(rijen.map((r) => r.mail as Mail));
  return rijen.length;
}

// Testmail voor de beheerder: gaat meteen (ook in de stille uren) en geeft een eventuele fout terug.
export async function verstuurTestmail(aan: string, naam?: string) {
  const manier = mailManier();
  if (!manier) {
    const mist = env("BREVO_API_KEY") && !env("MAIL_AFZENDER") ? " (BREVO_API_KEY staat er, maar MAIL_AFZENDER ontbreekt)" : "";
    return { ok: false as const, fout: "E-mail staat uit: er is geen verzendmanier volledig ingesteld" + mist + "." };
  }
  try {
    await verstuurEen({ aan, naam, onderwerp: "Testmail van de Padelplanner", tekst: `Hoi${naam ? " " + naam : ""},\n\nDit is een testmail. Verstuurd via ${manier}. Komt deze aan, dan werkt e-mail.` });
    return { ok: true as const, manier };
  } catch (e) {
    return { ok: false as const, fout: `Versturen via ${manier} mislukt: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400) };
  }
}

async function verstuurNu(mails: Mail[]) {
  if (!mailAan()) {
    console.log(`E-mail staat uit (geen sleutel of afzender ingesteld); ${mails.length} e-mail(s) niet verstuurd.`);
    return;
  }
  const res = await Promise.allSettled(mails.map(verstuurEen));
  for (const r of res) if (r.status === "rejected") console.error(String(r.reason));
}
