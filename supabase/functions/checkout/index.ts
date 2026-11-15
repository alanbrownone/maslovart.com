// Checkout for maslovart.com: turns the visitor's cart into a Stripe Checkout payment page.
// The browser sends only WHAT is in the cart (series + photo number + size, or a vintage print's photo);
// every price is looked up here from the saved site content, so nobody can change a price in the browser.
// Secrets: STRIPE_SECRET_KEY (sk_test_... while testing, sk_live_... at launch).
// Optional: SITE_ORIGINS (comma list of extra site addresses allowed to return to after paying).
// The order itself is saved and emailed by the "stripe-webhook" function once Stripe confirms payment.
import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const plain = (v: unknown) => String(v ?? "").replace(/[<>]/g, "").trim();

// Built-in values from site-v3.html, used only when the admin has not saved its own.
const SQ = [["10 x 10 in", 110], ["14 x 14 in", 140], ["16 x 16 in", 160], ["20 x 20 in", 200]];
const PANO = [["5 x 14 in", 140], ["6 x 18 in", 190], ["8 x 24 in", 220], ["10 x 30 in", 280]];
const BUILTIN: Record<string, { name: string; count: number; dir: string; prices: (string | number)[][]; noprint: number[] }> = {
  "ukrainian-time": { name: "Ukrainian Time", count: 22, dir: "v2/ukrainian-time", prices: SQ, noprint: [21, 22] },
  "annotations": { name: "Annotations", count: 31, dir: "v2/annotations", prices: [["11 x 14 in", 120], ["14 x 16 in", 140], ["16 x 20 in", 180]], noprint: [31] },
  "this-land-is-my-land": { name: "This Land is My Land", count: 39, dir: "v2/this-land-is-my-land", prices: PANO, noprint: [] },
  "from-ukraine-war": { name: "From Ukraine War: With and Without Love", count: 22, dir: "v2/from-ukraine-war", prices: PANO, noprint: [21, 22] },
  "stealing-time": { name: "Stealing Time", count: 23, dir: "v2/stealing-time", prices: [["9 x 14 in", 140], ["10 x 16 in", 160], ["12 x 20 in", 220]], noprint: [] },
  "soul-time": { name: "Soul Time", count: 19, dir: "soul-time", prices: SQ, noprint: [19] },
};
const DEFAULT_SHIPPING = 15; // dollars per order, until a rate is saved in admin > Orders > Shipping
const ORIGINS = ["https://maslov-art-homepage.netlify.app", "https://maslovart.com", "https://www.maslovart.com"];
const pad = (n: number) => (n < 10 ? "0" : "") + n;
const isCld = (u: string) => /^https:\/\/res\.cloudinary\.com\/[^\/]+\/image\/upload\//.test(u);
const cld = (u: string, t: string) => (isCld(u) ? u.replace("/image/upload/", "/image/upload/" + t + "/") : u);

type Doc = Record<string, any>;

function returnPage(v: unknown): URL | null {
  try {
    const u = new URL(String(v));
    const extra = (Deno.env.get("SITE_ORIGINS") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const preview = /^https:\/\/deploy-preview-\d+--maslov-art-homepage\.netlify\.app$/.test(u.origin);
    if (!preview && ![...ORIGINS, ...extra].includes(u.origin)) return null;
    if (!/^\/([\w-]+\.html)?$/.test(u.pathname)) return null;
    u.search = ""; u.hash = "";
    return u;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return json({ error: "Online checkout isn't switched on yet. Please call or email to order." }, 503);

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const page = returnPage(b.page);
  if (!page) return json({ error: "Checkout isn't available from this address." }, 400);
  const items = Array.isArray(b.items) ? b.items.slice(0, 25) : [];
  if (!items.length) return json({ error: "Your cart is empty." }, 400);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: row } = await sb.from("site_content").select("value").eq("key", "site").maybeSingle();
  const c: Doc = (row?.value as Doc) || {};

  const seriesInfo = (slug: string) => {
    const bi = BUILTIN[slug];
    const saved = c.series?.[slug];
    const inOrder = Array.isArray(c.seriesOrder) ? c.seriesOrder.includes(slug) : !!bi;
    if (!inOrder || (!bi && !saved)) return null;
    const photos: string[] | null = Array.isArray(c.photos?.[slug]) && c.photos[slug].length ? c.photos[slug] : null;
    const count = photos ? photos.length : bi ? bi.count : 0;
    const prices = (Array.isArray(c.prices?.[slug]) ? c.prices[slug] : bi?.prices || [])
      .filter((r: any) => r && String(r[0]).trim() && +r[1] > 0);
    const noprint: number[] = Array.isArray(c.noprint?.[slug]) ? c.noprint[slug].map(Number) : bi?.noprint || [];
    const name = plain(saved?.name) || bi?.name || slug;
    const photo = (n: number) => photos ? String(photos[n - 1] || "") : `images/${bi!.dir}/${pad(n)}.jpg`;
    return { name, count, prices, noprint, photo, titles: (c.titles?.[slug] || {}) as Record<string, string> };
  };
  const absImg = (src: string) => {
    if (isCld(src)) return cld(src, "c_limit,w_800,f_jpg,q_auto");
    if (/^images\/[\w\/.-]+$/.test(src)) return page.origin + "/" + src;
    return "";
  };

  const { data: soldRows } = await sb.from("vintage_sold").select("src");
  const sold = new Set((soldRows || []).map((r: { src: string }) => r.src));
  const vintage: Doc[] = Array.isArray(c.vintage) ? c.vintage : [];

  const lines: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  const seenVintage = new Set<string>();
  for (const it of items as Doc[]) {
    if (it?.kind === "new") {
      const slug = clip(it.slug, 60), n = Math.floor(+it.n), size = clip(it.size, 80);
      const qty = Math.min(Math.max(Math.floor(+it.qty || 1), 1), 10);
      const st = seriesInfo(slug);
      if (!st || !(n >= 1 && n <= st.count) || st.noprint.includes(n)) return json({ error: "One of the prints in your cart is no longer available. Please remove it and try again." }, 409);
      const pr = st.prices.find((r: any) => String(r[0]).trim() === size);
      if (!pr) return json({ error: `The ${size || "chosen"} size of ${st.name}, No. ${n} is no longer offered. Please remove it and choose again.` }, 409);
      const title = plain(st.titles[String(n)]);
      const img = absImg(st.photo(n));
      lines.push({
        quantity: qty,
        price_data: {
          currency: "usd",
          unit_amount: Math.round(+pr[1] * 100),
          product_data: {
            name: `${st.name}, No. ${n}${title ? " · " + title : ""}`.slice(0, 250),
            description: `New print · ${size} · archival pigment (giclée) print, made to order, signed by the artist`,
            ...(img ? { images: [img] } : {}),
            metadata: { kind: "new", slug, n: String(n), size },
          },
        },
      });
    } else if (it?.kind === "vintage") {
      const src = clip(it.src, 480);
      const v = vintage.find((x) => x && x.src === src);
      if (!v || !(+v.price > 0)) return json({ error: "One of the vintage prints in your cart is no longer for sale. Please remove it and try again." }, 409);
      if (sold.has(src)) return json({ error: `Sorry, "${plain(v.title)}" has just been sold. Please remove it from your cart.` }, 409);
      if (seenVintage.has(src)) continue;
      seenVintage.add(src);
      const img = absImg(src);
      const desc = ["Vintage print (one of a kind)", plain(v.size), v.code ? "Inventory no. " + plain(v.code) : ""].filter(Boolean).join(" · ");
      lines.push({
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Math.round(+v.price * 100),
          product_data: {
            name: (plain(v.title) || "Vintage print").slice(0, 250),
            description: desc,
            ...(img ? { images: [img] } : {}),
            metadata: { kind: "vintage", src, code: plain(v.code).slice(0, 100) },
          },
        },
      });
    }
  }
  if (!lines.length) return json({ error: "Your cart is empty." }, 400);

  const su = c.shipping?.us;
  const shipRate = su !== undefined && su !== null && su !== "" && +su >= 0 ? +su : DEFAULT_SHIPPING;
  const stripe = new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
  const base = page.toString();
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lines,
      shipping_address_collection: { allowed_countries: ["US"] },
      shipping_options: [{
        shipping_rate_data: {
          type: "fixed_amount",
          display_name: shipRate > 0 ? "Shipping within the United States" : "Free shipping within the United States",
          fixed_amount: { amount: Math.round(shipRate * 100), currency: "usd" },
        },
      }],
      phone_number_collection: { enabled: true },
      billing_address_collection: "auto",
      success_url: `${base}?order={CHECKOUT_SESSION_ID}#/order`,
      cancel_url: `${base}#/cart`,
      metadata: { site: "maslovart" },
    });
    return json({ url: session.url });
  } catch (e) {
    console.error("stripe", e);
    return json({ error: "Sorry, checkout couldn't start. Please try again, or call or email to order." }, 502);
  }
});
