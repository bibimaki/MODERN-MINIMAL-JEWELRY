/* ==========================================================================
   AVÉN — shared front-end logic

   Data source priority for products:
     1) Supabase `public.products` table (source of truth)
     2) products.json (static fallback, used only if Supabase is not
        configured or the request fails)
     3) FALLBACK_PRODUCTS below (last-resort, used only if products.json
        also fails to load — e.g. the site is opened directly from disk)

   Orders / Sales:
     - On checkout we insert one row per line item into `public.sales` and
       decrement `public.products.stock` for each item (only if Supabase is
       configured). This never blocks the order: if Supabase is unreachable
       the order still completes and is saved locally + pushed to the
       Google Sheet, exactly like before.
     - Orders themselves keep using the original Google Apps Script + Google
       Sheet flow (pushOrderToSheet / fetchOrdersFromSheet) and a
       localStorage cache as an offline fallback.

   NOTE ON SHEET COLUMNS: the CSV reader below expects a header row with
   (in any order): Order ID, Date, Name, Email, Phone, Address, Items,
   Total, Payment, Status. If your Apps Script writes different column
   names, update the `idx(...)` lookups in fetchOrdersFromSheet() to match.
   ========================================================================== */

const CONFIG = {
  SCRIPT_URL: "https://script.google.com/macros/s/AKfycbyjNd4nL4axozquGA69PCHOvH0s2wppBdKwckZbpeY4T1AlDcS_6QtwGNYneslvqEfTlg/exec",
  SHEET_CSV_URL: "https://docs.google.com/spreadsheets/d/e/2PACX-1vSOQNFOvk1vhRjDSmXo0yi_xPQjhiWTmaU24dPtczGzMTq_KbUVlRYPe2zFt3RRoG1UINpOKR5TqtHK/pub?gid=0&single=true&output=csv",

  // --- Supabase --------------------------------------------------------
  // ใส่ค่าโปรเจกต์ Supabase ของคุณเองที่นี่ (Project Settings → API)
  // ใช้ได้เฉพาะ "anon" / "publishable" key เท่านั้น — ห้ามใส่ service_role key
  // ที่นี่หรือในไฟล์ฝั่ง frontend ใด ๆ เด็ดขาด
  SUPABASE_URL: "",       // เช่น "https://xxxxxxxxxxxx.supabase.co"
  SUPABASE_ANON_KEY: "",  // anon/publishable key

  // เกตเบื้องต้นสำหรับหน้า Admin (สะดวกกันคนเดินผ่านเปิดดูเฉย ๆ)
  // นี่ไม่ใช่ระบบยืนยันตัวตนที่ปลอดภัยจริง (ไม่มี server-side auth, ไม่มี RLS
  // ผูกกับ user) ควรตั้งค่า Supabase Row Level Security ให้เหมาะสมและ/หรือ
  // ใส่ระบบ auth จริงภายหลังหากต้องเก็บข้อมูลลับ
  ADMIN_PASSCODE: "aven-admin",
};

const CATEGORY_NAMES = { rings: "Rings", necklaces: "Necklaces", bracelets: "Bracelets", earrings: "Earrings", limited: "Limited" };
const LOW_STOCK_THRESHOLD = 3;

/* Last-resort fallback — identical to products.json. Only used if BOTH
   Supabase and the products.json fetch fail (e.g. opened via file://). */
const FALLBACK_PRODUCTS = [
  { id:"aster-ring",     name:"Aster Ring",           category:"rings",      categoryLabel:"Ring",      price:890,  stock:12, description:"A slim band with a single raised facet, cast in brushed silver.", icon:"ring", image:"images/aster-ring.jpg", thumb:"images/thumb/aster-ring.jpg" },
  { id:"vela-ring",      name:"Vela Ring",            category:"rings",      categoryLabel:"Ring",      price:990,  stock:9,  description:"Twin bands that cross at the knuckle, polished to a soft sheen.", icon:"ring-double", image:"images/vela-ring.jpg", thumb:"images/thumb/vela-ring.jpg" },
  { id:"nox-necklace",   name:"Nox Necklace",         category:"necklaces",  categoryLabel:"Necklace",  price:1290, stock:7,  description:"A fine chain carrying a single flat disc, hung off-centre.", icon:"necklace", image:"images/nox-necklace.jpg", thumb:"images/thumb/nox-necklace.jpg" },
  { id:"elara-pendant",  name:"Elara Pendant",        category:"necklaces",  categoryLabel:"Necklace",  price:1490, stock:5,  description:"An open teardrop pendant on a delicate box chain.", icon:"pendant", image:"images/elara-pendant.jpg", thumb:"images/thumb/elara-pendant.jpg" },
  { id:"sera-bracelet",  name:"Sera Bracelet",        category:"bracelets",  categoryLabel:"Bracelet",  price:990,  stock:10, description:"A rounded cuff, left open at the wrist for an easy fit.", icon:"bracelet", image:"images/sera-bracelet.jpg", thumb:"images/thumb/sera-bracelet.jpg" },
  { id:"veyra-chain",    name:"Veyra Chain",          category:"bracelets",  categoryLabel:"Bracelet",  price:1190, stock:6,  description:"A linked chain bracelet with a hidden clasp.", icon:"bracelet-chain", image:"images/veyra-chain.jpg", thumb:"images/thumb/veyra-chain.jpg" },
  { id:"nova-hoop",      name:"Nova Hoop",            category:"earrings",   categoryLabel:"Earrings",  price:790,  stock:14, description:"Slim continuous hoops, sized to sit close to the ear.", icon:"hoop", image:"images/nova-hoop.jpg", thumb:"images/thumb/nova-hoop.jpg" },
  { id:"elan-drop",      name:"Élan Drop",            category:"earrings",   categoryLabel:"Earrings",  price:1090, stock:8,  description:"A single line drop, weighted at the tip.", icon:"drop", image:"images/elan-drop.jpg", thumb:"images/thumb/elan-drop.jpg" },
  { id:"aria-chain",     name:"Aria Chain",           category:"necklaces",  categoryLabel:"Necklace",  price:1390, stock:4,  description:"A layered double chain, worn as one necklace.", icon:"necklace-double", image:"images/aria-chain.jpg", thumb:"images/thumb/aria-chain.jpg" },
  { id:"signature-set",  name:"AVÉN Signature Set",   category:"limited",    categoryLabel:"Limited",   price:1990, stock:3,  description:"Ring, chain and hoop in one restrained edition. Numbered while stock lasts.", icon:"set", image:"images/signature-set.jpg", thumb:"images/thumb/signature-set.jpg" },
];

/* Runtime product state — populated by loadProducts() before any page renders. */
let PRODUCTS = [];
let PRODUCTS_SOURCE = "loading"; // "supabase" | "json" | "fallback"

/* ---------------- Icons (line-art, no photography needed) ---------------- */
function icon(name){
  const gold = "#b08d57", pewter = "#9a988f";
  const wrap = (inner) => `<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
  const icons = {
    "ring": `<circle cx="60" cy="68" r="30" stroke="${gold}" stroke-width="2.2"/><path d="M45 40 L60 20 L75 40 L60 50 Z" stroke="${pewter}" stroke-width="2.2" stroke-linejoin="round"/>`,
    "ring-double": `<circle cx="48" cy="66" r="26" stroke="${gold}" stroke-width="2.2"/><circle cx="72" cy="66" r="26" stroke="${pewter}" stroke-width="2"/>`,
    "necklace": `<path d="M20 24 C20 70, 100 70, 100 24" stroke="${pewter}" stroke-width="1.6"/><circle cx="70" cy="78" r="14" stroke="${gold}" stroke-width="2.2"/>`,
    "pendant": `<path d="M20 24 C20 62, 100 62, 100 24" stroke="${pewter}" stroke-width="1.6"/><path d="M60 60 C48 72, 48 92, 60 100 C72 92, 72 72, 60 60 Z" stroke="${gold}" stroke-width="2.2" stroke-linejoin="round"/>`,
    "bracelet": `<path d="M25 60 a35 35 0 1 0 70 4" stroke="${gold}" stroke-width="2.6" stroke-linecap="round"/>`,
    "bracelet-chain": `<ellipse cx="60" cy="60" rx="35" ry="30" stroke="${pewter}" stroke-width="1.4"/><circle cx="60" cy="30" r="5" stroke="${gold}" stroke-width="2"/><circle cx="88" cy="50" r="5" stroke="${gold}" stroke-width="2"/><circle cx="88" cy="72" r="5" stroke="${gold}" stroke-width="2"/><circle cx="60" cy="90" r="5" stroke="${gold}" stroke-width="2"/><circle cx="32" cy="72" r="5" stroke="${gold}" stroke-width="2"/><circle cx="32" cy="50" r="5" stroke="${gold}" stroke-width="2"/>`,
    "hoop": `<path d="M60 24 a30 30 0 1 0 0.1 0" stroke="${gold}" stroke-width="2.4"/><rect x="56" y="18" width="8" height="10" rx="2" stroke="${pewter}" stroke-width="1.6"/>`,
    "drop": `<rect x="56" y="16" width="8" height="8" rx="2" stroke="${pewter}" stroke-width="1.6"/><line x1="60" y1="26" x2="60" y2="66" stroke="${pewter}" stroke-width="1.6"/><path d="M60 66 C48 78, 48 98, 60 104 C72 98, 72 78, 60 66 Z" stroke="${gold}" stroke-width="2.2" stroke-linejoin="round"/>`,
    "necklace-double": `<path d="M18 22 C18 58, 102 58, 102 22" stroke="${pewter}" stroke-width="1.4"/><path d="M26 22 C26 76, 94 76, 94 22" stroke="${pewter}" stroke-width="1.4"/><circle cx="60" cy="82" r="10" stroke="${gold}" stroke-width="2.2"/>`,
    "set": `<circle cx="34" cy="82" r="16" stroke="${gold}" stroke-width="2"/><path d="M70 20 a20 20 0 1 0 0.1 0" stroke="${pewter}" stroke-width="2"/><path d="M60 70 C60 92, 96 92, 96 70" stroke="${gold}" stroke-width="1.6"/>`,
  };
  return wrap(icons[name] || icons["ring"]);
}
/* Default icon for a category when a Supabase row doesn't map to a known SKU icon. */
const CATEGORY_DEFAULT_ICON = { rings: "ring", necklaces: "necklace", bracelets: "bracelet", earrings: "hoop", limited: "set" };
const KNOWN_ICONS = FALLBACK_PRODUCTS.reduce((acc, p) => { acc[p.id] = p.icon; return acc; }, {});

/* ---------------- Supabase client ---------------- */
let _supabaseClient = null;
function getSupabase(){
  if(_supabaseClient) return _supabaseClient;
  if(!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) return null;
  if(typeof window === "undefined" || !window.supabase || !window.supabase.createClient) return null;
  try{
    _supabaseClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
    return _supabaseClient;
  } catch(e){
    console.warn("AVÉN: could not create Supabase client.", e);
    return null;
  }
}

function categorySlug(rawCategory){
  const key = String(rawCategory || "").trim().toLowerCase();
  const map = {
    ring: "rings", rings: "rings",
    necklace: "necklaces", necklaces: "necklaces",
    bracelet: "bracelets", bracelets: "bracelets",
    earring: "earrings", earrings: "earrings",
    limited: "limited",
  };
  return map[key] || key || "rings";
}
function categoryLabelFor(slug, rawCategory){
  if(CATEGORY_NAMES[slug]) return slug === "earrings" || slug === "limited" ? CATEGORY_NAMES[slug] : CATEGORY_NAMES[slug].replace(/s$/, "");
  return rawCategory || "Item";
}

/* Map a Supabase `products` row to the shape the rest of the app expects. */
function mapSupabaseRow(row){
  const slug = categorySlug(row.category);
  const id = row.sku || row.id;
  return {
    id: String(id),
    dbId: row.id,               // real uuid, needed for stock updates / sales
    sku: row.sku || String(id),
    name: row.name,
    category: slug,
    categoryLabel: categoryLabelFor(slug, row.category),
    price: Number(row.price) || 0,
    stock: row.stock === null || row.stock === undefined ? 0 : Number(row.stock),
    unit: row.unit || "piece",
    description: row.description || "A piece from the AVÉN collection.",
    icon: KNOWN_ICONS[row.sku] || CATEGORY_DEFAULT_ICON[slug] || "ring",
    image: `images/${row.sku || id}.jpg`,
    thumb: `images/thumb/${row.sku || id}.jpg`,
  };
}

async function fetchProductsFromSupabase(){
  const client = getSupabase();
  if(!client) return null;
  const { data, error } = await client.from("products").select("*").order("created_at", { ascending: true });
  if(error) throw error;
  if(!Array.isArray(data)) return null;
  return data.map(mapSupabaseRow);
}

async function fetchProductsFromJSON(){
  const res = await fetch("products.json", { cache: "no-store" });
  if(!res.ok) throw new Error("products.json responded with " + res.status);
  const data = await res.json();
  return data.map(p => ({ ...p, stock: p.stock ?? 10, description: p.description || "A piece from the AVÉN collection." }));
}

/* Loads PRODUCTS once, in priority order, and never throws — the site must
   never break just because a data source is unavailable. */
async function loadProducts(){
  try{
    const fromSupabase = await fetchProductsFromSupabase();
    if(fromSupabase && fromSupabase.length){
      PRODUCTS = fromSupabase;
      PRODUCTS_SOURCE = "supabase";
      return;
    }
  } catch(err){
    console.warn("AVÉN: Supabase products unavailable, falling back to products.json.", err);
  }
  try{
    const fromJSON = await fetchProductsFromJSON();
    if(fromJSON && fromJSON.length){
      PRODUCTS = fromJSON;
      PRODUCTS_SOURCE = "json";
      return;
    }
  } catch(err){
    console.warn("AVÉN: products.json unavailable, using built-in fallback data.", err);
  }
  PRODUCTS = FALLBACK_PRODUCTS;
  PRODUCTS_SOURCE = "fallback";
}

function findProduct(id){ return PRODUCTS.find(p => p.id === id); }

/* ---------------- Cart (localStorage) — stock aware ---------------- */
const CART_KEY = "aven_cart";
const ORDERS_KEY = "aven_orders";

function getCart(){
  try{ return JSON.parse(localStorage.getItem(CART_KEY)) || []; }
  catch(e){ return []; }
}
function saveCart(cart){ localStorage.setItem(CART_KEY, JSON.stringify(cart)); }

/* Returns the qty actually added (may be less than requested if stock-limited),
   or 0 if the item is sold out / not found. */
function addToCart(productId, qty=1){
  const product = findProduct(productId);
  if(!product) return 0;
  const cart = getCart();
  const line = cart.find(l => l.id === productId);
  const currentQty = line ? line.qty : 0;
  const maxAddable = Math.max(0, product.stock - currentQty);
  const toAdd = Math.min(qty, maxAddable);
  if(toAdd <= 0){ updateBagCount(); return 0; }
  if(line){ line.qty += toAdd; } else { cart.push({ id: productId, qty: toAdd }); }
  saveCart(cart);
  updateBagCount();
  return toAdd;
}
function updateCartQty(productId, qty){
  let cart = getCart();
  const product = findProduct(productId);
  const clamped = product ? Math.min(qty, product.stock) : qty;
  if(clamped <= 0){ cart = cart.filter(l => l.id !== productId); }
  else{ const line = cart.find(l => l.id === productId); if(line) line.qty = clamped; }
  saveCart(cart);
  updateBagCount();
  return clamped;
}
function removeFromCart(productId){
  saveCart(getCart().filter(l => l.id !== productId));
  updateBagCount();
}
function cartLinesWithProducts(){
  return getCart().map(line => {
    const product = findProduct(line.id);
    return product ? { ...line, product } : null;
  }).filter(Boolean);
}
function cartCount(){ return getCart().reduce((sum, l) => sum + l.qty, 0); }
function cartTotal(){ return cartLinesWithProducts().reduce((sum, l) => sum + l.product.price * l.qty, 0); }
function updateBagCount(){
  document.querySelectorAll("[data-bag-count]").forEach(el => { el.textContent = cartCount(); });
}

/* ---------------- Orders (localStorage cache + Google Sheet backend) ---------------- */
function getOrders(){
  try{ return JSON.parse(localStorage.getItem(ORDERS_KEY)) || []; }
  catch(e){ return []; }
}
function saveOrder(order){
  const orders = getOrders();
  orders.unshift(order);
  localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
  pushOrderToSheet(order);
}
function updateOrderStatus(orderId, status){
  const orders = getOrders().map(o => o.id === orderId ? { ...o, status } : o);
  localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
  pushStatusToSheet(orderId, status);
}

/* Collision-resistant order id: date + high-resolution timestamp (base36) +
   a short random suffix. Does NOT depend on getOrders().length, so it stays
   unique across devices/browsers/tabs instead of just locally. */
function generateOrderId(){
  const y = new Date().getFullYear();
  const time = Date.now().toString(36).toUpperCase();
  const rand = (crypto && crypto.getRandomValues)
    ? Array.from(crypto.getRandomValues(new Uint8Array(2))).map(b => b.toString(36)).join("").toUpperCase()
    : Math.random().toString(36).slice(2, 6).toUpperCase();
  return `AVN-${y}-${time}${rand}`;
}

/* --- Write path: POST to the Apps Script Web App ---
   Sent with mode:"no-cors" + text/plain, which is the standard way to call
   an Apps Script Web App from the browser without triggering a CORS
   preflight (Apps Script doesn't handle OPTIONS requests). This means the
   response body can't be read here — the order is already safe in
   localStorage regardless of whether the sheet write succeeds. */
function pushOrderToSheet(order){
  if(!CONFIG.SCRIPT_URL) return;
  fetch(CONFIG.SCRIPT_URL, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      type: "order",
      id: order.id,
      date: order.date,
      name: order.customer.name,
      email: order.customer.email,
      phone: order.customer.phone,
      address: order.customer.address,
      items: order.items.map(it => `${it.name} x${it.qty}`).join("; "),
      total: order.total,
      payment: order.payment,
      status: order.status,
    }),
  }).catch(() => { /* offline or blocked — order stays queued in localStorage */ });
}

function pushStatusToSheet(orderId, status){
  if(!CONFIG.SCRIPT_URL) return;
  fetch(CONFIG.SCRIPT_URL, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ type: "status", id: orderId, status }),
  }).catch(() => {});
}

/* --- Read path: GET the published sheet as CSV (Admin dashboard) --- */
function parseCSV(text){
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for(let i=0;i<text.length;i++){
    const c = text[i];
    if(inQuotes){
      if(c === '"'){
        if(text[i+1] === '"'){ field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if(c === '"') inQuotes = true;
      else if(c === ","){ row.push(field); field = ""; }
      else if(c === "\n" || c === "\r"){
        if(c === "\r" && text[i+1] === "\n") i++;
        row.push(field); field = "";
        if(row.length > 1 || row[0] !== ""){ rows.push(row); }
        row = [];
      } else field += c;
    }
  }
  if(field.length || row.length){ row.push(field); rows.push(row); }
  return rows;
}

async function fetchOrdersFromSheet(){
  if(!CONFIG.SHEET_CSV_URL) return null;
  try{
    const res = await fetch(CONFIG.SHEET_CSV_URL, { cache: "no-store" });
    if(!res.ok) throw new Error("Sheet responded with " + res.status);
    const text = await res.text();
    const rows = parseCSV(text);
    if(!rows.length) return [];

    const header = rows[0].map(h => h.trim().toLowerCase());
    const idx = (name) => header.indexOf(name);
    const iId = idx("order id") !== -1 ? idx("order id") : idx("id");
    const iDate = idx("date");
    const iName = idx("name");
    const iEmail = idx("email");
    const iPhone = idx("phone");
    const iAddress = idx("address");
    const iItems = idx("items");
    const iTotal = idx("total");
    const iPayment = idx("payment");
    const iStatus = idx("status");
    if(iId === -1) throw new Error("Sheet has no 'Order ID' column");

    return rows.slice(1).filter(r => r[iId]).map(r => ({
      id: r[iId],
      date: iDate !== -1 ? r[iDate] : "",
      customer: {
        name: iName !== -1 ? r[iName] : "",
        email: iEmail !== -1 ? r[iEmail] : "",
        phone: iPhone !== -1 ? r[iPhone] : "",
        address: iAddress !== -1 ? r[iAddress] : "",
      },
      items: iItems !== -1 && r[iItems]
        ? r[iItems].split(";").map(s => s.trim()).filter(Boolean).map(s => {
            const m = s.match(/^(.*)\sx(\d+)$/i);
            return m ? { name: m[1], qty: Number(m[2]), price: 0 } : { name: s, qty: 1, price: 0 };
          })
        : [],
      total: iTotal !== -1 ? Number(String(r[iTotal]).replace(/[^\d.-]/g, "")) || 0 : 0,
      payment: iPayment !== -1 ? r[iPayment] : "",
      status: iStatus !== -1 && r[iStatus] ? r[iStatus] : "Pending",
    }));
  } catch(err){
    console.warn("AVÉN: couldn't load orders from the Google Sheet, showing local data only.", err);
    return null;
  }
}

/* Merge: sheet is source of truth for orders it already has; any order
   placed locally but not yet visible in the sheet (just-submitted, or the
   fetch failed) is still shown so nothing appears to vanish from Admin. */
async function loadOrdersForAdmin(){
  const local = getOrders();
  const sheet = await fetchOrdersFromSheet();
  if(!sheet) return local;
  const sheetIds = new Set(sheet.map(o => o.id));
  const localOnly = local.filter(o => !sheetIds.has(o.id));
  return [...localOnly, ...sheet];
}

/* ---------------- Supabase: sales + stock deduction ---------------- */
/* Re-checks live stock, records one `sales` row per line item, and
   decrements `products.stock`. Runs sequentially per line so each update can
   verify remaining stock (prevents negative stock under light concurrency).
   Returns { ok, unavailable } — `unavailable` lists any item that could not
   be fully fulfilled so the caller can inform the customer. Never throws —
   if Supabase isn't configured this simply resolves as ok (order still goes
   through via the existing Google Sheet + localStorage flow). */
async function recordSaleAndDeductStock(order){
  const client = getSupabase();
  if(!client) return { ok: true, unavailable: [] };

  const unavailable = [];
  for(const item of order.items){
    const product = findProduct(item.id);
    const dbId = product && product.dbId ? product.dbId : item.id;
    try{
      const { data: fresh, error: readErr } = await client.from("products").select("id, stock").eq("id", dbId).single();
      if(readErr || !fresh){ unavailable.push({ ...item, reason: "not-found" }); continue; }

      const qtyToDeduct = Math.min(item.qty, fresh.stock);
      if(qtyToDeduct <= 0){ unavailable.push({ ...item, reason: "sold-out" }); continue; }

      const newStock = Math.max(0, fresh.stock - qtyToDeduct);
      const { error: updateErr } = await client.from("products").update({ stock: newStock }).eq("id", dbId).gte("stock", qtyToDeduct);
      if(updateErr){ unavailable.push({ ...item, reason: "update-failed" }); continue; }

      await client.from("sales").insert({
        product_id: dbId,
        product_name: item.name,
        quantity: qtyToDeduct,
        total_price: item.price * qtyToDeduct,
        sold_at: order.date,
      });

      if(qtyToDeduct < item.qty){ unavailable.push({ ...item, reason: "partial", fulfilled: qtyToDeduct }); }
    } catch(err){
      console.warn("AVÉN: could not record sale / deduct stock for", item.id, err);
      unavailable.push({ ...item, reason: "error" });
    }
  }
  return { ok: unavailable.length === 0, unavailable };
}

/* ---------------- Formatting ---------------- */
function formatBaht(n){ return "฿\u200a" + Number(n).toLocaleString("en-US"); }

function stockPillHTML(stock){
  if(stock <= 0) return `<span class="stock-pill sold-out">Sold Out</span>`;
  if(stock <= LOW_STOCK_THRESHOLD) return `<span class="stock-pill low-stock">Only ${stock} left</span>`;
  return `<span class="stock-pill in-stock">In Stock</span>`;
}

/* ---------------- Toast ---------------- */
function showToast(msg, isError=false){
  let toast = document.querySelector(".toast");
  if(!toast){
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.toggle("toast-error", !!isError);
  toast.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

/* ---------------- Nav toggle (mobile) ---------------- */
function initNav(){
  const toggle = document.querySelector(".nav-toggle");
  const links = document.querySelector(".nav-links");
  if(toggle && links){
    toggle.addEventListener("click", () => links.classList.toggle("open"));
    links.querySelectorAll("a").forEach(a => a.addEventListener("click", () => links.classList.remove("open")));
  }
  updateBagCount();
}

/* ==========================================================================
   Page: Home (index.html) — featured products
   ========================================================================== */
function renderFeatured(){
  const el = document.querySelector("#featured-grid");
  if(!el) return;
  const preferredIds = ["nox-necklace","aster-ring","nova-hoop","signature-set"];
  let featured = preferredIds.map(id => findProduct(id)).filter(Boolean);
  if(featured.length < 4){
    const rest = PRODUCTS.filter(p => !featured.includes(p));
    featured = featured.concat(rest).slice(0, 4);
  }
  el.innerHTML = featured.map(productCardHTML).join("");
  bindAddToBagButtons(el);
  bindQuickViewButtons(el);
}

/* ==========================================================================
   Page: Shop (product.html)
   ========================================================================== */
function productCardHTML(p){
  const mediaInner = p.image
    ? `<img src="${p.image}" alt="${p.name}" loading="lazy" onerror="this.outerHTML = window.icon('${p.icon}')">`
    : icon(p.icon);
  return `
    <article class="product-card" data-id="${p.id}" data-category="${p.category}" data-name="${p.name.toLowerCase()}" data-price="${p.price}">
      <a href="order.html?add=${p.id}" class="product-media" aria-label="View ${p.name}">
        ${p.category === "limited" ? `<span class="tag-limited">LIMITED</span>` : ""}
        ${mediaInner}
      </a>
      <button type="button" class="quick-view-btn" data-quick-view="${p.id}" aria-label="Quick view ${p.name}">Quick View</button>
      <div class="product-info">
        <span class="product-cat">${p.categoryLabel}</span>
        <h3 class="product-name"><a href="order.html?add=${p.id}">${p.name}</a></h3>
        <div class="product-row">
          <span class="product-price">${formatBaht(p.price)}</span>
          ${stockPillHTML(p.stock)}
        </div>
        <div class="product-row">
          <button class="add-bag" data-add="${p.id}" ${p.stock <= 0 ? "disabled" : ""}>${p.stock <= 0 ? "Sold Out" : "Add to Bag"}</button>
        </div>
      </div>
    </article>`;
}

function bindAddToBagButtons(scope){
  scope.querySelectorAll("[data-add]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const id = btn.getAttribute("data-add");
      const product = findProduct(id);
      if(!product || product.stock <= 0) return;
      const added = addToCart(id, 1);
      if(added <= 0){
        showToast(`No more ${product.name} in stock`, true);
        return;
      }
      btn.classList.add("added");
      btn.textContent = "Added";
      showToast(`${product.name} added to your bag`);
      setTimeout(() => { btn.classList.remove("added"); btn.textContent = product.stock <= 0 ? "Sold Out" : "Add to Bag"; }, 1400);
    });
  });
}

function initShopPage(){
  const grid = document.querySelector("#shop-grid");
  if(!grid) return;

  const params = new URLSearchParams(location.search);
  let activeFilter = params.get("category") || "all";
  let query = "";
  let sortBy = "featured";

  const pills = document.querySelectorAll(".pill");
  const searchInput = document.querySelector("#shop-search");
  const sortSelect = document.querySelector("#shop-sort");
  const emptyState = document.querySelector("#shop-empty");

  function render(){
    let filtered = PRODUCTS.filter(p => {
      const matchCat = activeFilter === "all" || p.category === activeFilter;
      const matchQuery = !query || p.name.toLowerCase().includes(query) || p.categoryLabel.toLowerCase().includes(query);
      return matchCat && matchQuery;
    });
    if(sortBy === "price-asc") filtered = filtered.slice().sort((a,b) => a.price - b.price);
    if(sortBy === "price-desc") filtered = filtered.slice().sort((a,b) => b.price - a.price);
    if(sortBy === "name") filtered = filtered.slice().sort((a,b) => a.name.localeCompare(b.name));

    grid.innerHTML = filtered.map(productCardHTML).join("");
    emptyState.style.display = filtered.length ? "none" : "block";
    bindAddToBagButtons(grid);
    bindQuickViewButtons(grid);
  }

  pills.forEach(pill => {
    if(pill.getAttribute("data-filter") === activeFilter) pill.classList.add("active");
    pill.addEventListener("click", () => {
      pills.forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      activeFilter = pill.getAttribute("data-filter");
      render();
    });
  });

  if(searchInput){
    searchInput.addEventListener("input", () => {
      query = searchInput.value.trim().toLowerCase();
      render();
    });
  }
  if(sortSelect){
    sortSelect.addEventListener("change", () => {
      sortBy = sortSelect.value;
      render();
    });
  }

  render();

  if(PRODUCTS_SOURCE !== "supabase"){
    const note = document.querySelector("#shop-data-note");
    if(note){
      note.textContent = PRODUCTS_SOURCE === "json"
        ? "กำลังแสดงข้อมูลสินค้าจากไฟล์สำรอง (products.json) — เชื่อมต่อ Supabase ไม่สำเร็จ"
        : "กำลังแสดงข้อมูลสินค้าตัวอย่างในเครื่อง — ไม่พบทั้ง Supabase และ products.json";
      note.classList.add("warn");
    }
  }
}

/* ==========================================================================
   Quick View / Product Detail modal (used on home + shop pages)
   ========================================================================== */
function ensurePDPRoot(){
  let root = document.querySelector("#pdp-root");
  if(!root){
    root = document.createElement("div");
    root.id = "pdp-root";
    document.body.appendChild(root);
  }
  return root;
}

function relatedProducts(p, count=3){
  const sameCategory = PRODUCTS.filter(x => x.category === p.category && x.id !== p.id);
  const others = PRODUCTS.filter(x => x.category !== p.category && x.id !== p.id);
  return sameCategory.concat(others).slice(0, count);
}

function openProductModal(id){
  const p = findProduct(id);
  if(!p) return;
  const root = ensurePDPRoot();
  const related = relatedProducts(p);
  const mediaInner = p.image
    ? `<img src="${p.image}" alt="${p.name}" onerror="this.outerHTML = window.icon('${p.icon}')">`
    : icon(p.icon);

  root.innerHTML = `
    <div class="pdp-backdrop" id="pdp-backdrop">
      <div class="pdp-card" role="dialog" aria-modal="true" aria-label="${p.name}">
        <button type="button" class="pdp-close" id="pdp-close" aria-label="Close">×</button>
        <div class="pdp-media">${mediaInner}</div>
        <div class="pdp-info">
          <span class="product-cat">${p.categoryLabel}</span>
          <h2 class="product-name">${p.name}</h2>
          <div class="product-row"><span class="product-price">${formatBaht(p.price)}</span>${stockPillHTML(p.stock)}</div>
          <p class="pdp-desc">${p.description}</p>
          <div class="pdp-qty-row">
            <div class="qty-row">
              <button type="button" class="qty-btn" id="pdp-qty-down">−</button>
              <span class="qty-val" id="pdp-qty-val">1</span>
              <button type="button" class="qty-btn" id="pdp-qty-up">+</button>
            </div>
            <button type="button" class="btn btn-dark" id="pdp-add" ${p.stock <= 0 ? "disabled" : ""}>${p.stock <= 0 ? "Sold Out" : "Add to Bag"}</button>
          </div>
          ${related.length ? `
          <div class="pdp-related">
            <h4>Complete the Look</h4>
            <div class="pdp-related-grid">
              ${related.map(r => `
                <a class="pdp-related-item" href="order.html?add=${r.id}" data-quick-view-link="${r.id}">
                  <div class="thumb-box">${r.image ? `<img src="${r.image}" alt="${r.name}" onerror="this.outerHTML = window.icon('${r.icon}')">` : icon(r.icon)}</div>
                  <span class="thumb-name">${r.name}</span>
                </a>
              `).join("")}
            </div>
          </div>` : ""}
        </div>
      </div>
    </div>`;

  let qty = 1;
  const qtyVal = root.querySelector("#pdp-qty-val");
  const addBtn = root.querySelector("#pdp-add");
  root.querySelector("#pdp-qty-up").addEventListener("click", () => {
    if(qty < p.stock){ qty++; qtyVal.textContent = qty; }
  });
  root.querySelector("#pdp-qty-down").addEventListener("click", () => {
    if(qty > 1){ qty--; qtyVal.textContent = qty; }
  });
  if(addBtn){
    addBtn.addEventListener("click", () => {
      const added = addToCart(p.id, qty);
      if(added <= 0){ showToast(`No more ${p.name} in stock`, true); return; }
      showToast(`${p.name} ×${added} added to your bag`);
      closeProductModal();
    });
  }
  root.querySelectorAll("[data-quick-view-link]").forEach(a => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openProductModal(a.getAttribute("data-quick-view-link"));
    });
  });

  const backdrop = root.querySelector("#pdp-backdrop");
  root.querySelector("#pdp-close").addEventListener("click", closeProductModal);
  backdrop.addEventListener("click", (e) => { if(e.target === backdrop) closeProductModal(); });
  document.addEventListener("keydown", pdpEscHandler);
  requestAnimationFrame(() => backdrop.classList.add("open"));
}

function pdpEscHandler(e){ if(e.key === "Escape") closeProductModal(); }

function closeProductModal(){
  const backdrop = document.querySelector("#pdp-backdrop");
  if(!backdrop) return;
  backdrop.classList.remove("open");
  document.removeEventListener("keydown", pdpEscHandler);
  setTimeout(() => { const root = document.querySelector("#pdp-root"); if(root) root.innerHTML = ""; }, 260);
}

function bindQuickViewButtons(scope){
  scope.querySelectorAll("[data-quick-view]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      openProductModal(btn.getAttribute("data-quick-view"));
    });
  });
}

/* ==========================================================================
   Page: Checkout (order.html)
   ========================================================================== */
function setCheckoutStatus(el, mode, message){
  if(!el) return;
  el.className = "checkout-status" + (mode ? " show " + mode : "");
  el.innerHTML = mode === "pending" ? `<span class="spinner"></span><span>${message}</span>` : `<span>${message}</span>`;
}

function validateCheckoutForm(form){
  let valid = true;
  const rules = [
    { id: "fullName", test: v => v.trim().length >= 2, msg: "กรุณากรอกชื่อ-นามสกุล" },
    { id: "email", test: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()), msg: "อีเมลไม่ถูกต้อง" },
    { id: "phone", test: v => /^[0-9+\-\s]{9,15}$/.test(v.trim()), msg: "เบอร์โทรไม่ถูกต้อง" },
    { id: "address", test: v => v.trim().length >= 8, msg: "กรุณากรอกที่อยู่ให้ครบถ้วน" },
  ];
  rules.forEach(rule => {
    const input = form.querySelector(`#${rule.id}`);
    if(!input) return;
    const group = input.closest(".field-group");
    const ok = rule.test(input.value || "");
    if(group){
      group.classList.toggle("has-error", !ok);
      let err = group.querySelector(".field-error");
      if(!err){
        err = document.createElement("div");
        err.className = "field-error";
        group.appendChild(err);
      }
      err.textContent = rule.msg;
    }
    if(!ok) valid = false;
  });
  return valid;
}

function initCheckoutPage(){
  const summaryEl = document.querySelector("#bag-summary-lines");
  if(!summaryEl) return;

  const params = new URLSearchParams(location.search);
  const addId = params.get("add");
  if(addId && findProduct(addId)){
    const added = addToCart(addId, 1);
    if(added <= 0) showToast("Sorry, that piece is currently sold out.", true);
    history.replaceState(null, "", "order.html");
  }

  function renderBag(){
    const lines = cartLinesWithProducts();
    const form = document.querySelector("#checkout-form");
    const placeBtn = document.querySelector("#place-order");

    if(!lines.length){
      summaryEl.innerHTML = `<div class="empty-bag">Your bag is empty.<br><a href="product.html" class="btn btn-ghost mt-64" style="margin-top:20px;display:inline-flex;">Browse the Shop</a></div>`;
      document.querySelector("#summary-totals").style.display = "none";
      if(form) form.style.display = "none";
      if(placeBtn) placeBtn.disabled = true;
      return;
    }

    if(form) form.style.display = "";
    document.querySelector("#summary-totals").style.display = "";
    if(placeBtn) placeBtn.disabled = false;

    summaryEl.innerHTML = lines.map(l => `
      <div class="bag-line" data-line="${l.id}">
        <div class="bag-thumb">${l.product.thumb ? `<img src="${l.product.thumb}" alt="${l.product.name}" onerror="this.outerHTML = window.icon('${l.product.icon}')">` : icon(l.product.icon)}</div>
        <div class="bag-meta">
          <span class="name">${l.product.name}</span>
          <span class="cat">${l.product.categoryLabel} · ${formatBaht(l.product.price)}</span>
          <div class="qty-row">
            <button type="button" class="qty-btn" data-qty-down>−</button>
            <span class="qty-val">${l.qty}</span>
            <button type="button" class="qty-btn" data-qty-up ${l.qty >= l.product.stock ? "disabled" : ""}>+</button>
          </div>
          ${l.qty >= l.product.stock ? `<div class="qty-limit-note">Max stock reached (${l.product.stock})</div>` : ""}
          <a class="remove-line" data-remove href="#">Remove</a>
        </div>
        <span class="line-total">${formatBaht(l.product.price * l.qty)}</span>
      </div>
    `).join("");

    const subtotal = cartTotal();
    const shipping = subtotal > 0 ? 0 : 0;
    document.querySelector("#sum-subtotal").textContent = formatBaht(subtotal);
    document.querySelector("#sum-shipping").textContent = shipping === 0 ? "Free" : formatBaht(shipping);
    document.querySelector("#sum-total").textContent = formatBaht(subtotal + shipping);

    summaryEl.querySelectorAll("[data-qty-up]").forEach(b => b.addEventListener("click", () => {
      const id = b.closest(".bag-line").getAttribute("data-line");
      const line = getCart().find(l => l.id === id);
      updateCartQty(id, line.qty + 1);
      renderBag();
    }));
    summaryEl.querySelectorAll("[data-qty-down]").forEach(b => b.addEventListener("click", () => {
      const id = b.closest(".bag-line").getAttribute("data-line");
      const line = getCart().find(l => l.id === id);
      updateCartQty(id, line.qty - 1);
      renderBag();
    }));
    summaryEl.querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", (e) => {
      e.preventDefault();
      removeFromCart(b.closest(".bag-line").getAttribute("data-line"));
      renderBag();
    }));
  }

  renderBag();

  document.querySelectorAll(".pay-option").forEach(opt => {
    opt.addEventListener("click", () => {
      document.querySelectorAll(".pay-option").forEach(o => o.classList.remove("selected"));
      opt.classList.add("selected");
      opt.querySelector("input").checked = true;
    });
  });

  const form = document.querySelector("#checkout-form");
  const statusEl = document.querySelector("#checkout-status");
  let submitting = false;

  if(form){
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if(submitting) return; // guard against double submit

      const lines = cartLinesWithProducts();
      if(!lines.length) return;
      if(!validateCheckoutForm(form)){
        setCheckoutStatus(statusEl, "error", "กรุณาตรวจสอบข้อมูลที่กรอกอีกครั้ง");
        return;
      }

      submitting = true;
      const placeBtn = document.querySelector("#place-order");
      if(placeBtn) placeBtn.disabled = true;
      setCheckoutStatus(statusEl, "pending", "กำลังบันทึกคำสั่งซื้อของคุณ…");

      const data = new FormData(form);
      const payment = form.querySelector('input[name="payment"]:checked');

      const order = {
        id: generateOrderId(),
        date: new Date().toISOString(),
        customer: {
          name: data.get("fullName"),
          email: data.get("email"),
          phone: data.get("phone"),
          address: data.get("address"),
        },
        items: lines.map(l => ({ id: l.id, name: l.product.name, qty: l.qty, price: l.product.price })),
        payment: payment ? payment.value : "Cash on Delivery",
        total: cartTotal(),
        status: "Pending",
      };

      try{
        const stockResult = await recordSaleAndDeductStock(order);
        if(!stockResult.ok && stockResult.unavailable.length){
          const names = stockResult.unavailable.map(u => u.name).join(", ");
          showToast(`บางรายการมีสต็อกไม่พอเต็มจำนวน: ${names}`, true);
        }
        saveOrder(order);
        saveCart([]);
        sessionStorage.setItem("aven_last_order", order.id);
        setCheckoutStatus(statusEl, "pending", "สำเร็จ! กำลังพาไปหน้ายืนยันคำสั่งซื้อ…");
        location.href = "thankyou.html?order=" + encodeURIComponent(order.id);
      } catch(err){
        console.error("AVÉN checkout error:", err);
        submitting = false;
        if(placeBtn) placeBtn.disabled = false;
        setCheckoutStatus(statusEl, "error", "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
      }
    });
  }
}

/* ==========================================================================
   Page: Thank You (thankyou.html)
   ========================================================================== */
function initThankYouPage(){
  const el = document.querySelector("#confirm-content");
  if(!el) return;

  const params = new URLSearchParams(location.search);
  const orderId = params.get("order") || sessionStorage.getItem("aven_last_order");
  const order = getOrders().find(o => o.id === orderId);

  if(!order){
    el.innerHTML = `
      <p class="lede center" style="margin:0 auto;">We couldn't find that order. If you just placed one, check the admin dashboard, or head back to the shop.</p>
      <div class="confirm-actions mt-64" style="margin-top:36px;">
        <a href="product.html" class="btn btn-dark">Continue Shopping</a>
      </div>`;
    return;
  }

  document.querySelector("#confirm-order-id").textContent = "Order " + order.id;
  document.querySelector("#confirm-summary-lines").innerHTML = order.items.map(it => `
    <div class="bag-line">
      <div class="bag-thumb">${(() => { const prod = findProduct(it.id); return prod && prod.thumb ? `<img src="${prod.thumb}" alt="${prod.name}" onerror="this.outerHTML = window.icon('${prod.icon}')">` : icon((prod||{}).icon || "ring"); })()}</div>
      <div class="bag-meta">
        <span class="name">${it.name}</span>
        <span class="cat">Qty ${it.qty} · ${formatBaht(it.price)} each</span>
      </div>
      <span class="line-total">${formatBaht(it.price * it.qty)}</span>
    </div>
  `).join("");
  document.querySelector("#confirm-total").textContent = formatBaht(order.total);
  document.querySelector("#confirm-payment").textContent = order.payment;
  showToast("Order confirmed — thank you!");
}

/* ==========================================================================
   Page: Admin (admin.html)
   ========================================================================== */
const ADMIN_SESSION_KEY = "aven_admin_ok";

function initAdminGate(){
  const gate = document.querySelector("#admin-gate");
  const shell = document.querySelector(".admin-shell");
  if(!gate || !shell) return true; // no gate markup on this page — proceed

  if(sessionStorage.getItem(ADMIN_SESSION_KEY) === "1"){
    gate.style.display = "none";
    shell.style.display = "";
    return true;
  }

  gate.style.display = "flex";
  shell.style.display = "none";
  const form = gate.querySelector("#admin-gate-form");
  const input = gate.querySelector("#admin-gate-input");
  const error = gate.querySelector("#admin-gate-error");
  if(form){
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if(input.value === CONFIG.ADMIN_PASSCODE){
        sessionStorage.setItem(ADMIN_SESSION_KEY, "1");
        gate.style.display = "none";
        shell.style.display = "";
        initAdminPage();
      } else {
        error.classList.add("show");
        input.value = "";
        input.focus();
      }
    });
  }
  return false;
}

function renderStockOverview(){
  const body = document.querySelector("#stock-table-body");
  if(!body) return;
  body.innerHTML = PRODUCTS.map(p => {
    const pct = Math.max(4, Math.min(100, Math.round((p.stock / 15) * 100)));
    const cls = p.stock <= 0 ? "out" : (p.stock <= LOW_STOCK_THRESHOLD ? "low" : "");
    return `
      <tr>
        <td>${p.name}</td>
        <td>${p.categoryLabel}</td>
        <td>${formatBaht(p.price)}</td>
        <td class="${cls}">
          ${p.stock} ${p.unit || "piece"}${p.stock === 1 ? "" : "s"}
          <div class="stock-bar-track"><div class="stock-bar-fill" style="width:${pct}%"></div></div>
        </td>
      </tr>`;
  }).join("");
}

function initAdminPage(){
  const table = document.querySelector("#orders-table-body");
  if(!table) return;

  renderStockOverview();

  let allOrders = [];
  let query = "";
  let statusFilter = "all";

  const searchInput = document.querySelector("#admin-search");
  const filterPills = document.querySelectorAll("[data-order-filter]");

  function renderTable(){
    const filtered = allOrders.filter(o => {
      const matchStatus = statusFilter === "all" || o.status === statusFilter;
      const q = query.toLowerCase();
      const matchQuery = !q || o.id.toLowerCase().includes(q) || (o.customer.name||"").toLowerCase().includes(q) || (o.customer.email||"").toLowerCase().includes(q);
      return matchStatus && matchQuery;
    });

    const emptyEl = document.querySelector("#admin-empty");
    if(!filtered.length){
      table.innerHTML = "";
      emptyEl.style.display = "block";
      emptyEl.textContent = allOrders.length ? "No orders match your search." : "No orders yet. Once a customer checks out, orders will appear here.";
      return;
    }
    emptyEl.style.display = "none";

    table.innerHTML = filtered.map(o => `
      <tr>
        <td>${o.id}</td>
        <td>
          <div style="font-weight:600;">${o.customer.name}</div>
          <div style="color:var(--pewter);font-size:0.8rem;">${o.customer.email}</div>
        </td>
        <td class="order-products-cell">
          ${o.items.map(it => `<div>${it.name} ×${it.qty}</div>`).join("")}
        </td>
        <td>${formatBaht(o.total)}</td>
        <td>${o.payment}</td>
        <td>
          <select class="status-select" data-order="${o.id}">
            <option value="Pending" ${o.status==="Pending"?"selected":""}>Pending</option>
            <option value="Paid" ${o.status==="Paid"?"selected":""}>Paid</option>
            <option value="Shipping" ${o.status==="Shipping"?"selected":""}>Shipping</option>
          </select>
        </td>
      </tr>
    `).join("");

    table.querySelectorAll(".status-select").forEach(sel => {
      sel.addEventListener("change", () => {
        updateOrderStatus(sel.getAttribute("data-order"), sel.value);
        allOrders = allOrders.map(o => o.id === sel.getAttribute("data-order") ? { ...o, status: sel.value } : o);
        renderTable();
      });
    });
  }

  async function loadAndRender(){
    allOrders = await loadOrdersForAdmin();
    document.querySelector("#stat-orders").textContent = allOrders.length;
    document.querySelector("#stat-revenue").textContent = formatBaht(allOrders.reduce((s,o) => s + o.total, 0));
    document.querySelector("#stat-products").textContent = PRODUCTS.length;
    document.querySelector("#stat-pending").textContent = allOrders.filter(o => o.status === "Pending").length;
    renderTable();
  }

  if(searchInput){
    searchInput.addEventListener("input", () => { query = searchInput.value.trim(); renderTable(); });
  }
  filterPills.forEach(pill => {
    pill.addEventListener("click", () => {
      filterPills.forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      statusFilter = pill.getAttribute("data-order-filter");
      renderTable();
    });
  });

  loadAndRender();
}

/* ---------------- Init ---------------- */
document.addEventListener("DOMContentLoaded", async () => {
  await loadProducts();

  initNav();
  renderFeatured();
  initShopPage();
  initCheckoutPage();
  initThankYouPage();

  // Admin page renders only after the passcode gate (if present) is passed.
  if(document.querySelector("#admin-gate")){
    if(initAdminGate()) initAdminPage();
  } else if(document.querySelector("#orders-table-body")){
    initAdminPage();
  }

  const form = document.querySelector(".news-form");
  if(form){
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      showToast("Thanks — you're on the list.");
      form.reset();
    });
  }
});

// Expose icon() for inline onerror handlers used in dynamically-built HTML strings.
window.icon = icon;
