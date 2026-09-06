/* ==========================================================================
   AVÉN — shared front-end logic

   Backend: Google Apps Script + Google Sheet
   - New orders and status changes are POSTed to the Apps Script Web App.
   - The Admin dashboard reads orders back by fetching the sheet's published
     CSV (faster and CORS-friendly for a public GET than calling the script).
   - localStorage is kept as an offline fallback/cache: if the network call
     fails, checkout still completes and admin still shows the last known
     data, instead of breaking the flow.

   NOTE ON SHEET COLUMNS: the CSV reader below expects a header row with
   (in any order): Order ID, Date, Name, Email, Phone, Address, Items,
   Total, Payment, Status. If your Apps Script writes different column
   names, update the `idx(...)` lookups in fetchOrdersFromSheet() to match.
   The POST payload sent on checkout uses those same field names (lowercase
   keys) — adjust doPost() on the Apps Script side, or the keys below, so
   both sides agree.
   ========================================================================== */

const CONFIG = {
  SCRIPT_URL: "https://script.google.com/macros/s/AKfycbyjNd4nL4axozquGA69PCHOvH0s2wppBdKwckZbpeY4T1AlDcS_6QtwGNYneslvqEfTlg/exec",
  SHEET_CSV_URL: "https://docs.google.com/spreadsheets/d/e/2PACX-1vSOQNFOvk1vhRjDSmXo0yi_xPQjhiWTmaU24dPtczGzMTq_KbUVlRYPe2zFt3RRoG1UINpOKR5TqtHK/pub?gid=0&single=true&output=csv",
};

const PRODUCTS = [
  { id:"aster-ring",     name:"Aster Ring",           category:"rings",      categoryLabel:"Ring",      price:890,  description:"A slim band with a single raised facet, cast in brushed silver.", icon:"ring", image:"images/aster-ring.jpg", thumb:"images/thumb/aster-ring.jpg" },
  { id:"vela-ring",      name:"Vela Ring",            category:"rings",      categoryLabel:"Ring",      price:990,  description:"Twin bands that cross at the knuckle, polished to a soft sheen.", icon:"ring-double", image:"images/vela-ring.jpg", thumb:"images/thumb/vela-ring.jpg" },
  { id:"nox-necklace",   name:"Nox Necklace",         category:"necklaces",  categoryLabel:"Necklace",  price:1290, description:"A fine chain carrying a single flat disc, hung off-centre.", icon:"necklace", image:"images/nox-necklace.jpg", thumb:"images/thumb/nox-necklace.jpg" },
  { id:"elara-pendant",  name:"Elara Pendant",        category:"necklaces",  categoryLabel:"Necklace",  price:1490, description:"An open teardrop pendant on a delicate box chain.", icon:"pendant", image:"images/elara-pendant.jpg", thumb:"images/thumb/elara-pendant.jpg" },
  { id:"sera-bracelet",  name:"Sera Bracelet",        category:"bracelets",  categoryLabel:"Bracelet",  price:990,  description:"A rounded cuff, left open at the wrist for an easy fit.", icon:"bracelet", image:"images/sera-bracelet.jpg", thumb:"images/thumb/sera-bracelet.jpg" },
  { id:"veyra-chain",    name:"Veyra Chain",          category:"bracelets",  categoryLabel:"Bracelet",  price:1190, description:"A linked chain bracelet with a hidden clasp.", icon:"bracelet-chain", image:"images/veyra-chain.jpg", thumb:"images/thumb/veyra-chain.jpg" },
  { id:"nova-hoop",      name:"Nova Hoop",            category:"earrings",   categoryLabel:"Earrings",  price:790,  description:"Slim continuous hoops, sized to sit close to the ear.", icon:"hoop", image:"images/nova-hoop.jpg", thumb:"images/thumb/nova-hoop.jpg" },
  { id:"elan-drop",      name:"Élan Drop",            category:"earrings",   categoryLabel:"Earrings",  price:1090, description:"A single line drop, weighted at the tip.", icon:"drop", image:"images/elan-drop.jpg", thumb:"images/thumb/elan-drop.jpg" },
  { id:"aria-chain",     name:"Aria Chain",           category:"necklaces",  categoryLabel:"Necklace",  price:1390, description:"A layered double chain, worn as one necklace.", icon:"necklace-double", image:"images/aria-chain.jpg", thumb:"images/thumb/aria-chain.jpg" },
  { id:"signature-set",  name:"AVÉN Signature Set",   category:"limited",    categoryLabel:"Limited",   price:1990, description:"Ring, chain and hoop in one restrained edition. Numbered while stock lasts.", icon:"set", image:"images/signature-set.jpg", thumb:"images/thumb/signature-set.jpg" },
];

const CATEGORY_NAMES = { rings:"Rings", necklaces:"Necklaces", bracelets:"Bracelets", earrings:"Earrings", limited:"Limited" };

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

/* ---------------- Cart (localStorage) ---------------- */
const CART_KEY = "aven_cart";
const ORDERS_KEY = "aven_orders";

function getCart(){
  try{ return JSON.parse(localStorage.getItem(CART_KEY)) || []; }
  catch(e){ return []; }
}
function saveCart(cart){ localStorage.setItem(CART_KEY, JSON.stringify(cart)); }

function addToCart(productId, qty=1){
  const cart = getCart();
  const line = cart.find(l => l.id === productId);
  if(line){ line.qty += qty; } else { cart.push({ id: productId, qty }); }
  saveCart(cart);
  updateBagCount();
}
function updateCartQty(productId, qty){
  let cart = getCart();
  if(qty <= 0){ cart = cart.filter(l => l.id !== productId); }
  else{ const line = cart.find(l => l.id === productId); if(line) line.qty = qty; }
  saveCart(cart);
  updateBagCount();
}
function removeFromCart(productId){
  saveCart(getCart().filter(l => l.id !== productId));
  updateBagCount();
}
function cartLinesWithProducts(){
  return getCart().map(line => {
    const product = PRODUCTS.find(p => p.id === line.id);
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
function generateOrderId(){
  const n = getOrders().length + 1;
  const y = new Date().getFullYear();
  return `AVN-${y}-${String(n).padStart(4,"0")}`;
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

/* ---------------- Formatting ---------------- */
function formatBaht(n){ return "฿\u200a" + Number(n).toLocaleString("en-US"); }

/* ---------------- Toast ---------------- */
function showToast(msg){
  let toast = document.querySelector(".toast");
  if(!toast){
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("show"), 2200);
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
  const featured = ["nox-necklace","aster-ring","nova-hoop","signature-set"]
    .map(id => PRODUCTS.find(p => p.id === id));
  el.innerHTML = featured.map(productCardHTML).join("");
  bindAddToBagButtons(el);
}

/* ==========================================================================
   Page: Shop (product.html)
   ========================================================================== */
function productCardHTML(p){
  return `
    <article class="product-card" data-id="${p.id}" data-category="${p.category}" data-name="${p.name.toLowerCase()}">
      <a href="order.html?add=${p.id}" class="product-media" aria-label="View ${p.name}">
        ${p.category === "limited" ? `<span class="tag-limited">LIMITED</span>` : ""}
        ${p.image ? `<img src="${p.image}" alt="${p.name}" loading="lazy">` : icon(p.icon)}
      </a>
      <div class="product-info">
        <span class="product-cat">${p.categoryLabel}</span>
        <h3 class="product-name"><a href="order.html?add=${p.id}">${p.name}</a></h3>
        <div class="product-row">
          <span class="product-price">${formatBaht(p.price)}</span>
          <button class="add-bag" data-add="${p.id}">Add to Bag</button>
        </div>
      </div>
    </article>`;
}

function bindAddToBagButtons(scope){
  scope.querySelectorAll("[data-add]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const id = btn.getAttribute("data-add");
      const product = PRODUCTS.find(p => p.id === id);
      addToCart(id, 1);
      btn.classList.add("added");
      btn.textContent = "Added";
      showToast(`${product.name} added to your bag`);
      setTimeout(() => { btn.classList.remove("added"); btn.textContent = "Add to Bag"; }, 1400);
    });
  });
}

function initShopPage(){
  const grid = document.querySelector("#shop-grid");
  if(!grid) return;

  const params = new URLSearchParams(location.search);
  let activeFilter = params.get("category") || "all";
  let query = "";

  const pills = document.querySelectorAll(".pill");
  const searchInput = document.querySelector("#shop-search");
  const emptyState = document.querySelector("#shop-empty");

  function render(){
    const filtered = PRODUCTS.filter(p => {
      const matchCat = activeFilter === "all" || p.category === activeFilter;
      const matchQuery = !query || p.name.toLowerCase().includes(query) || p.categoryLabel.toLowerCase().includes(query);
      return matchCat && matchQuery;
    });
    grid.innerHTML = filtered.map(productCardHTML).join("");
    emptyState.style.display = filtered.length ? "none" : "block";
    bindAddToBagButtons(grid);
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

  render();
}

/* ==========================================================================
   Page: Checkout (order.html)
   ========================================================================== */
function initCheckoutPage(){
  const summaryEl = document.querySelector("#bag-summary-lines");
  if(!summaryEl) return;

  const params = new URLSearchParams(location.search);
  const addId = params.get("add");
  if(addId && PRODUCTS.find(p => p.id === addId)){
    addToCart(addId, 1);
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
        <div class="bag-thumb">${l.product.thumb ? `<img src="${l.product.thumb}" alt="${l.product.name}">` : icon(l.product.icon)}</div>
        <div class="bag-meta">
          <span class="name">${l.product.name}</span>
          <span class="cat">${l.product.categoryLabel} · ${formatBaht(l.product.price)}</span>
          <div class="qty-row">
            <button type="button" class="qty-btn" data-qty-down>−</button>
            <span class="qty-val">${l.qty}</span>
            <button type="button" class="qty-btn" data-qty-up>+</button>
          </div>
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
  if(form){
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const lines = cartLinesWithProducts();
      if(!lines.length) return;

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

      saveOrder(order);
      saveCart([]);
      sessionStorage.setItem("aven_last_order", order.id);
      location.href = "thankyou.html?order=" + encodeURIComponent(order.id);
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
      <div class="bag-thumb">${(() => { const prod = PRODUCTS.find(p=>p.id===it.id); return prod && prod.thumb ? `<img src="${prod.thumb}" alt="${prod.name}">` : icon((prod||{}).icon || "ring"); })()}</div>
      <div class="bag-meta">
        <span class="name">${it.name}</span>
        <span class="cat">Qty ${it.qty} · ${formatBaht(it.price)} each</span>
      </div>
      <span class="line-total">${formatBaht(it.price * it.qty)}</span>
    </div>
  `).join("");
  document.querySelector("#confirm-total").textContent = formatBaht(order.total);
  document.querySelector("#confirm-payment").textContent = order.payment;
}

/* ==========================================================================
   Page: Admin (admin.html)
   ========================================================================== */
function initAdminPage(){
  const table = document.querySelector("#orders-table-body");
  if(!table) return;

  async function render(){
    const orders = await loadOrdersForAdmin();
    document.querySelector("#stat-orders").textContent = orders.length;
    document.querySelector("#stat-revenue").textContent = formatBaht(orders.reduce((s,o) => s + o.total, 0));
    document.querySelector("#stat-products").textContent = PRODUCTS.length;
    document.querySelector("#stat-pending").textContent = orders.filter(o => o.status === "Pending").length;

    const emptyEl = document.querySelector("#admin-empty");
    if(!orders.length){
      table.innerHTML = "";
      emptyEl.style.display = "block";
      return;
    }
    emptyEl.style.display = "none";

    table.innerHTML = orders.map(o => `
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
        render();
      });
    });
  }

  render();
}

/* ---------------- Init ---------------- */
document.addEventListener("DOMContentLoaded", () => {
  initNav();
  renderFeatured();
  initShopPage();
  initCheckoutPage();
  initThankYouPage();
  initAdminPage();

  const form = document.querySelector(".news-form");
  if(form){
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      showToast("Thanks — you're on the list.");
      form.reset();
    });
  }
});
