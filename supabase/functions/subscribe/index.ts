// Mailing list for maslovart.com, with double opt-in.
//   action "subscribe":   saves a PENDING row and emails a "Please confirm" link (nobody is added yet)
//   action "confirm":     the button on the confirm page (POST with the token) marks the address confirmed
//   action "unsubscribe": the button on the unsubscribe page (POST with the token) takes the address off
// Opening a link never changes anything (email scanners open links); only the button POST does.
// Secrets: RESEND_API_KEY, MAIL_FROM (already set for "contact"). Optional: SITE_URL (the page the email
// links point to). "New subscriber" alerts go to admin users with subscriber_alerts checked
// (fallback when none: SIGNUP_ALERT_TO, then CONTACT_TO).
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const HOUR = 3600_000, TOKEN_LIFE = 48 * HOUR, PER_IP_PER_HOUR = 5;
const CHECK_EMAIL = { ok: true, message: "Almost done! Check your email to confirm." };

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const site = () => Deno.env.get("SITE_URL") || "https://maslov-art-homepage.netlify.app/site-v3.html";

async function sendEmail(to: string, subject: string, html: string, extra: Record<string, unknown> = {}) {
  const key = Deno.env.get("RESEND_API_KEY"), from = Deno.env.get("MAIL_FROM");
  if (!key || !from) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, ...extra }),
    });
    return r.ok;
  } catch { return false; }
}
const wrap = (inner: string) =>
  `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:24px;color:#222;line-height:1.5">${inner}` +
  `<p style="color:#888;font-size:12px;margin-top:32px">Guennadi Maslov &middot; maslovart.com</p></div>`;
const button = (href: string, label: string) =>
  `<p style="margin:28px 0"><a href="${esc(href)}" style="background:#1f6f68;color:#fff;padding:12px 22px;border-radius:4px;text-decoration:none;font-family:Arial,sans-serif;font-size:15px">${label}</a></p>`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const now = Date.now(), nowIso = new Date(now).toISOString();
  const action = clip(b.action, 20) || "subscribe";

  // Clean up: signups never confirmed within 48 hours are deleted, and old attempt records too.
  await sb.from("subscribers").delete().eq("status", "pending").lt("token_expires_at", nowIso);
  await sb.from("signup_attempts").delete().lt("created_at", new Date(now - 24 * HOUR).toISOString());

  if (action === "confirm") {
    const token = clip(b.token, 100);
    if (!token) return json({ error: "This link is missing its code." }, 400);
    const unsub = newToken();
    // One update that only succeeds for a pending, unexpired token, so a token works exactly once.
    const { data: row } = await sb.from("subscribers")
      .update({ status: "confirmed", confirmed_at: nowIso, token_hash: null, token_expires_at: null, unsub_hash: await sha256(unsub) })
      .eq("token_hash", await sha256(token)).eq("status", "pending").gt("token_expires_at", nowIso)
      .select("email,name").maybeSingle();
    if (!row) return json({ error: "This link has expired or was already used. Please sign up again." }, 410);

    // Only confirmed subscribers get the welcome email, and only they trigger the alert.
    const hi = row.name ? `Dear ${esc(row.name)},` : "Hello,";
    await sendEmail(row.email, "Welcome to Guennadi Maslov's mailing list", wrap(
      `<p>${hi}</p><p>Thank you for joining my mailing list. I'll write when there are new prints, exhibitions and news.</p>` +
      `<p>Guennadi</p><p style="color:#888;font-size:12px;margin-top:28px">Don't want these emails? <a href="${esc(site() + "#/unsubscribe/" + unsub)}" style="color:#888">Unsubscribe</a>.</p>`));
    // "New subscriber" alert: to every admin user with the box checked in admin > Users.
    // If nobody has it checked, SIGNUP_ALERT_TO / CONTACT_TO is used so alerts aren't silently lost.
    const { data: admins } = await sb.from("admins").select("email").eq("subscriber_alerts", true);
    let alertTo = (admins || []).map((a) => a.email).filter(Boolean);
    if (!alertTo.length) alertTo = [Deno.env.get("SIGNUP_ALERT_TO") || Deno.env.get("CONTACT_TO") || ""].filter(Boolean);
    if (alertTo.length) {
      const { count } = await sb.from("subscribers").select("id", { count: "exact", head: true }).eq("status", "confirmed");
      const html = wrap(`<p><b>${esc(row.name || "(no name)")}</b> &lt;${esc(row.email)}&gt; confirmed their subscription.</p><p>Confirmed subscribers now: ${count ?? "?"}</p>` +
        `<p style="color:#888;font-size:12px">You get this because "New subscriber alerts" is checked for you in the website admin (Users tab).</p>`);
      for (const to of alertTo) await sendEmail(to, `New subscriber: ${row.email}`, html);
    }
    return json({ ok: true });
  }

  if (action === "unsubscribe") {
    const token = clip(b.token, 100);
    if (!token) return json({ error: "This link is missing its code." }, 400);
    const { data: row } = await sb.from("subscribers")
      .update({ status: "unsubscribed", unsubscribed_at: nowIso })
      .eq("unsub_hash", await sha256(token)).eq("status", "confirmed").select("id").maybeSingle();
    if (!row) {
      const { data: done } = await sb.from("subscribers").select("id").eq("unsub_hash", await sha256(token)).maybeSingle();
      if (!done) return json({ error: "This unsubscribe link isn't valid." }, 404);
    }
    return json({ ok: true });
  }

  if (action !== "subscribe") return json({ error: "Bad request" }, 400);

  // Hidden "website" field: real people leave it empty, robots fill it in. Pretend it worked.
  if (clip(b.website, 200)) return json(CHECK_EMAIL);
  const email = clip(b.email, 200).toLowerCase(), name = clip(b.name, 120), page = clip(b.page, 300);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Please check your email address." }, 400);

  // At most 5 signup tries per visitor (IP) per hour.
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  const ipHash = ip ? await sha256(ip + "|maslovart") : null;
  if (ipHash) {
    const { count } = await sb.from("signup_attempts").select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash).gte("created_at", new Date(now - HOUR).toISOString());
    if ((count ?? 0) >= PER_IP_PER_HOUR) return json({ error: "Too many tries. Please try again later." }, 429);
    await sb.from("signup_attempts").insert({ ip_hash: ipHash });
  }

  const { data: cur } = await sb.from("subscribers").select("id,status,last_sent_at").eq("email", email).maybeSingle();
  // Already on the list: same answer, no email, so the form never reveals who is subscribed.
  if (cur?.status === "confirmed") return json(CHECK_EMAIL);
  // Already pending: re-send at most once an hour.
  if (cur?.status === "pending" && cur.last_sent_at && now - Date.parse(cur.last_sent_at) < HOUR) return json(CHECK_EMAIL);

  const token = newToken();
  const fields = {
    status: "pending", token_hash: await sha256(token), token_expires_at: new Date(now + TOKEN_LIFE).toISOString(),
    last_sent_at: nowIso, ip_hash: ipHash, page: page || null, ...(name ? { name } : {}),
  };
  const { error } = cur
    ? await sb.from("subscribers").update(fields).eq("id", cur.id)
    : await sb.from("subscribers").insert({ email, ...fields });
  if (error) return json({ error: "Sorry, something went wrong. Please try again later." }, 500);

  const ok = await sendEmail(email, "Please confirm your subscription", wrap(
    `<p>${name ? `Dear ${esc(name)},` : "Hello,"}</p><p>Someone (hopefully you) asked to join Guennadi Maslov's mailing list with this address. ` +
    `Please confirm by pressing the button below, then <b>"Yes, add me to the list"</b>.</p>` +
    button(site() + "#/confirm/" + token, "Confirm my subscription") +
    `<p style="color:#666;font-size:13px">This link works for 48 hours. If you didn't sign up, just ignore this email and you won't hear from us.</p>`));
  if (!ok) {
    await sb.from("subscribers").update({ last_sent_at: null }).eq("email", email);
    return json({ error: "Sorry, we couldn't send the confirmation email. Please try again later." }, 502);
  }
  return json(CHECK_EMAIL);
});
