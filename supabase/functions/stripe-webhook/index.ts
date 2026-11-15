// Stripe tells this function when a checkout is paid. It then
//   1. saves the order (table "orders"; seen in admin > Orders),
//   2. marks vintage prints in the order as Sold (table "vintage_sold"),
//   3. emails the buyer a confirmation and Guennadi an order alert (through Resend).
// Stripe may send the same event more than once; an order is saved and emailed only once.
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (whsec_...), RESEND_API_KEY, MAIL_FROM.
// Order alerts go to ORDER_TO (comma list) if set, otherwise CONTACT_TO, otherwise guennadi@maslovart.com.
import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (cents: number) => "$" + (cents / 100).toFixed(2).replace(/\.00$/, "");

type Item = { name: string; description: string; qty: number; unit_cents: number; total_cents: number; kind: string; slug?: string; n?: number; size?: string; src?: string; code?: string };

function addressLines(a: Stripe.Address | null | undefined): string[] {
  if (!a) return [];
  return [a.line1, a.line2, [a.city, a.state, a.postal_code].filter(Boolean).join(", ").replace(/, (\d)/, " $1"), a.country && a.country !== "US" ? a.country : ""]
    .filter((x): x is string => !!x && !!x.trim());
}

function itemsTable(items: Item[], sub: number, ship: number, tax: number, total: number) {
  const row = (l: string, r: string, bold = false) =>
    `<tr><td style="padding:6px 0;${bold ? "font-weight:700;" : ""}">${l}</td><td style="padding:6px 0;text-align:right;${bold ? "font-weight:700;" : ""}">${r}</td></tr>`;
  return `<table style="width:100%;max-width:560px;border-collapse:collapse;font-size:15px">` +
    items.map((i) => `<tr><td style="padding:8px 0;border-bottom:1px solid #eee"><b>${esc(i.name)}</b>${i.qty > 1 ? " &times; " + i.qty : ""}<br><span style="color:#666;font-size:13px">${esc(i.description)}</span></td>` +
      `<td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;vertical-align:top">${money(i.total_cents)}</td></tr>`).join("") +
    row("Prints", money(sub)) + row("Shipping", ship ? money(ship) : "Free") + (tax ? row("Tax", money(tax)) : "") + row("Total paid", money(total), true) +
    `</table>`;
}

async function send(key: string, payload: Record<string, unknown>) {
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) console.error("resend", r.status, await r.text());
    return r.ok;
  } catch (e) { console.error("resend", e); return false; }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Use POST", { status: 405 });
  const key = Deno.env.get("STRIPE_SECRET_KEY"), whsec = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!key || !whsec) return new Response("Not set up", { status: 503 });
  const stripe = new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, req.headers.get("stripe-signature") || "", whsec, undefined, Stripe.createSubtleCryptoProvider());
  } catch (e) {
    console.error("bad signature", e);
    return new Response("Bad signature", { status: 400 });
  }
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") return new Response("ignored");
  const ev = event.data.object as Stripe.Checkout.Session;
  if (ev.payment_status !== "paid") return new Response("not paid yet");

  const s = await stripe.checkout.sessions.retrieve(ev.id, { expand: ["line_items.data.price.product"] });
  const items: Item[] = (s.line_items?.data || []).map((li) => {
    const p = li.price?.product as Stripe.Product;
    const m = p?.metadata || {};
    return {
      name: p?.name || li.description || "Print", description: p?.description || "", qty: li.quantity || 1,
      unit_cents: li.price?.unit_amount || 0, total_cents: li.amount_total, kind: m.kind || "",
      ...(m.slug ? { slug: m.slug, n: +m.n, size: m.size } : {}), ...(m.src ? { src: m.src } : {}), ...(m.code ? { code: m.code } : {}),
    };
  });
  const cd = s.customer_details;
  const ship = s.collected_information?.shipping_details || (s as any).shipping_details || null;
  const order = {
    stripe_session_id: s.id,
    payment_intent: typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id || null,
    livemode: s.livemode,
    customer_name: cd?.name || null, email: cd?.email || null, phone: cd?.phone || null,
    ship_name: ship?.name || cd?.name || null, ship_address: ship?.address || cd?.address || null,
    items, subtotal_cents: s.amount_subtotal || 0, shipping_cents: s.total_details?.amount_shipping || 0,
    tax_cents: s.total_details?.amount_tax || 0, total_cents: s.amount_total || 0, currency: s.currency || "usd",
  };

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  // Save once. If Stripe repeats the event and the emails already went out, stop here.
  const { data: existing } = await sb.from("orders").select("id,emails_sent").eq("stripe_session_id", s.id).maybeSingle();
  let id = existing?.id as number | undefined;
  if (!id) {
    const { data: ins, error } = await sb.from("orders").insert(order).select("id").single();
    if (error) {
      const { data: again } = await sb.from("orders").select("id,emails_sent").eq("stripe_session_id", s.id).maybeSingle();
      if (!again) { console.error("save order", error); return new Response("Could not save", { status: 500 }); }
      if (again.emails_sent) return new Response("ok");
      id = again.id;
    } else id = ins.id;
  } else if (existing?.emails_sent) return new Response("ok");

  const vin = items.filter((i) => i.kind === "vintage" && i.src).map((i) => ({ src: i.src!, order_id: id }));
  if (vin.length) await sb.from("vintage_sold").upsert(vin, { onConflict: "src", ignoreDuplicates: true });

  const rk = Deno.env.get("RESEND_API_KEY"), from = Deno.env.get("MAIL_FROM");
  if (!rk || !from) return new Response("ok (no email set up)");
  const contact = Deno.env.get("CONTACT_TO") || "guennadi@maslovart.com";
  const alertTo = (Deno.env.get("ORDER_TO") || contact).split(",").map((x) => x.trim()).filter(Boolean);
  const test = s.livemode ? "" : "[TEST] ";
  const num = `#${id}`;
  const addr = [order.ship_name || "", ...addressLines(order.ship_address as Stripe.Address)].filter(Boolean);
  const site = (() => { try { return new URL(s.success_url || "").origin; } catch { return "https://maslov-art-homepage.netlify.app"; } })();
  const table = itemsTable(items, order.subtotal_cents, order.shipping_cents, order.tax_cents, order.total_cents);
  const hasNew = items.some((i) => i.kind === "new"), hasVin = items.some((i) => i.kind === "vintage");
  const wrap = (inner: string) => `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d1d1b;max-width:600px;line-height:1.55">${inner}</div>`;

  let buyerOk = true;
  if (order.email) {
    const when = [hasNew ? "New prints are made to order and ship within 1&ndash;2 weeks." : "", hasVin ? "Vintage prints ship flat, packed between rigid boards." : ""].filter(Boolean).join(" ");
    buyerOk = await send(rk, {
      from, to: [order.email], reply_to: contact,
      subject: `${test}Your Maslov Art order ${num}`,
      html: wrap(`<h2 style="font-family:Georgia,serif;font-weight:400">Thank you for your order${order.customer_name ? ", " + esc(order.customer_name.split(" ")[0]) : ""}!</h2>` +
        `<p>This email confirms your order <b>${num}</b>. ${when} You'll get another email with tracking details when it ships.</p>` + table +
        (addr.length ? `<p style="margin-top:18px"><b>Shipping to</b><br>${addr.map(esc).join("<br>")}</p>` : "") +
        `<p>Questions about your order? Just reply to this email, or write to <a href="mailto:${esc(contact)}">${esc(contact)}</a>.</p>` +
        `<p>With gratitude,<br>Guennadi Maslov</p>`),
    });
  }
  const alertOk = await send(rk, {
    from, to: alertTo, ...(order.email ? { reply_to: order.email } : {}),
    subject: `${test}New order ${num}: ${money(order.total_cents)} from ${order.customer_name || order.email || "a buyer"}`,
    html: wrap(`<h2 style="font-family:Georgia,serif;font-weight:400">New order ${num}${test ? " (test payment, no real money)" : ""}</h2>` + table +
      `<p style="margin-top:18px"><b>Buyer</b><br>${esc(order.customer_name || "")}<br>${esc(order.email || "")}${order.phone ? "<br>" + esc(order.phone) : ""}</p>` +
      (addr.length ? `<p><b>Ship to</b><br>${addr.map(esc).join("<br>")}</p>` : "") +
      items.filter((i) => i.kind === "vintage").map((i) => `<p style="color:#a35d00">Vintage print${i.code ? " (inventory no. " + esc(i.code) + ")" : ""} is now shown as Sold on the site.</p>`).join("") +
      `<p>See all orders in the <a href="${site}/admin.html">site admin</a> &rsaquo; Orders. Payment details are in Stripe.</p>`),
  });
  if (buyerOk && alertOk) await sb.from("orders").update({ emails_sent: true }).eq("id", id);
  return new Response("ok");
});
