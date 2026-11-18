// E-mail versturen voor de Padelplanner. Drie mogelijkheden (de eerste die is ingesteld wordt gebruikt):
// - Gmail (of andere SMTP): SMTP_USER (je Gmail-adres) en SMTP_PASS (een app-wachtwoord). Gratis, tot ~500 mails per dag.
//   Optioneel SMTP_HOST/SMTP_PORT voor een andere mailprovider (standaard smtp.gmail.com:465).
// - Brevo: BREVO_API_KEY en MAIL_AFZENDER (een in Brevo geverifieerd adres).
// - Resend: RESEND_API_KEY en MAIL_AFZENDER.
// Zonder instellingen worden er geen e-mails verstuurd; de site blijft gewoon werken (uitnodigingen staan ook op de site).
import nodemailer from "nodemailer";

// Bijlage als tekst (bijv. een agenda-afspraak .ics).
export type Bijlage = { naam: string; inhoud: string; type: string };
export type Mail = { aan: string; naam?: string; onderwerp: string; tekst: string; knoppen?: { label: string; url: string }[]; bijlagen?: Bijlage[] };

const env = (k: string): string | undefined => (globalThis as any).Netlify?.env?.get(k) ?? process.env[k];

const smtpAan = () => !!(env("SMTP_USER") && env("SMTP_PASS"));
export const mailAan = () => smtpAan() || (!!(env("BREVO_API_KEY") || env("RESEND_API_KEY")) && !!env("MAIL_AFZENDER"));

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
  const brevo = env("BREVO_API_KEY");
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

// Verstuurt alle mails; een mislukte mail houdt de rest niet tegen.
export async function verstuur(mails: Mail[]) {
  if (!mails.length) return;
  if (!mailAan()) {
    console.log(`E-mail staat uit (geen sleutel of afzender ingesteld); ${mails.length} e-mail(s) niet verstuurd.`);
    return;
  }
  const res = await Promise.allSettled(mails.map(verstuurEen));
  for (const r of res) if (r.status === "rejected") console.error(String(r.reason));
}
