// POST /submit — OshiGuide（apply.html / inquiry.html）の2フォームを受ける共通Worker。
// KV に保存してから Email Routing で Gmail へ通知する。{"test":true} は健全性チェック用。
// animesensei-contact と同じ構造だが、フォームごとに項目名が違うので固定の message フィールドを要求しない。
import { EmailMessage } from "cloudflare:email";

const FROM = "inquiry@animesenseijp.com";
const TO = "icchan417@gmail.com";
const ORIGIN = "https://yukitchy.github.io";
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const clip = (v, n) => String(v ?? "").slice(0, n).trim();

const cors = {
  "access-control-allow-origin": ORIGIN,
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...cors } });

function mime({ subject, replyTo, body }) {
  const lines = [
    `From: OshiGuide <${FROM}>`,
    `To: ${TO}`,
    replyTo && `Reply-To: ${replyTo}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@animesenseijp.com>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(body).replace(/.{76}/g, "$&\r\n"),
  ].filter(Boolean);
  return lines.join("\r\n") + "\r\n";
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
    let d;
    try { d = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }

    const test = d.test === true;
    if (!test && clip(d.website, 200)) return json({ ok: true }); // honeypot: 黙って捨てる

    const kind = test ? "test" : (clip(d.kind, 20) === "apply" ? "apply" : "inquiry");
    const name = test ? "health-check" : clip(d.name, 100);
    const email = test ? "" : clip(d.email, 200);
    if (!test && (!name || !EMAIL_RE.test(email)))
      return json({ ok: false, error: "name and a valid email are required" }, 400);

    const extra = {};
    for (const [k, v] of Object.entries(d))
      if (!["name", "email", "website", "test", "kind"].includes(k) && clip(v, 1) && Object.keys(extra).length < 20)
        extra[clip(k, 40)] = clip(v, 2000);

    const key = `${kind}:${new Date().toISOString()}:${crypto.randomUUID().slice(0, 8)}`;
    const rec = { at: new Date().toISOString(), kind, name, email, extra, page: req.headers.get("referer") || "", status: "received" };
    const ttl = test ? { expirationTtl: 7 * 86400 } : {};
    try { await env.OSHI_SUBMISSIONS.put(key, JSON.stringify(rec), ttl); }
    catch (e) { return json({ ok: false, error: "store failed" }, 500); }

    const label = kind === "apply" ? "Guide application" : test ? "Health check" : "Trip inquiry";
    const subject = `[OshiGuide] ${label} — ${name}`;
    const body = [`Kind: ${kind}`, `Name: ${name}`, `Email: ${email}`, `Page: ${rec.page}`, "",
      ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`), "", `KV: ${key}`].join("\n");
    const send = async () => {
      try {
        await env.MAIL.send(new EmailMessage(FROM, TO, mime({ subject, replyTo: email, body })));
        rec.status = "sent";
      } catch (e) {
        rec.status = "mail_failed"; rec.error = String(e).slice(0, 300);
      }
      await env.OSHI_SUBMISSIONS.put(key, JSON.stringify(rec), ttl).catch(() => {});
    };
    if (!test) { ctx.waitUntil(send()); return json({ ok: true, key }); }
    await send();
    return json({ ok: true, mail: rec.status === "sent" ? "sent" : "failed", key });
  },
};
