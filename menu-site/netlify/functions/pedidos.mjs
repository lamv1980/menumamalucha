import { getStore } from "@netlify/blobs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const str = (v, max) => String(v ?? "").trim().slice(0, max);

function autorizado(req) {
  const pass = process.env.ADMIN_PASSWORD;
  return Boolean(pass) && req.headers.get("x-admin-password") === pass;
}

const peso = (n) =>
  "$" + n.toLocaleString("es-MX", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// Manda el pedido a tu Telegram. Devuelve true solo si Telegram lo aceptó.
async function avisarTelegram(p) {
  const token = process.env.TELEGRAM_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;

  const c = p.cliente;
  const texto = [
    `🛒 NUEVO PEDIDO · Folio ${p.folio}`,
    "",
    ...p.items.map((i) => `• ${i.qty} x ${i.nombre} — ${peso(i.qty * i.precio)}`),
    "",
    `Total: ${peso(p.total)}`,
    `Pago: ${p.pago}`,
    "",
    `Cliente: ${c.nombre}`,
    `Teléfono: ${c.telefono}`,
    `WhatsApp: https://wa.me/52${c.telefono}`,
    `Dirección: ${c.calle} #${c.numext}, Col. ${c.colonia}, C.P. ${c.cp}`,
    ...(p.notas ? ["", `Notas: ${p.notas}`] : []),
  ].join("\n");

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: texto, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(6000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export default async (req) => {
  const store = getStore("pedidos");

  // ---------- Cliente: registrar un pedido (público) ----------
  if (req.method === "POST") {
    let b;
    try { b = await req.json(); } catch { return json({ error: "Datos inválidos." }, 400); }

    // Campo trampa para bots: un cliente real nunca lo llena.
    if (b.empresa) return json({ ok: true, folio: "" });

    const c = b.cliente || {};
    const cliente = {
      nombre: str(c.nombre, 80),
      telefono: str(c.telefono, 20).replace(/\D/g, ""),
      calle: str(c.calle, 80),
      numext: str(c.numext, 20),
      colonia: str(c.colonia, 80),
      cp: str(c.cp, 5),
    };
    if (!cliente.nombre || cliente.telefono.length !== 10 || !cliente.calle ||
        !cliente.numext || !cliente.colonia || !/^\d{5}$/.test(cliente.cp)) {
      return json({ error: "Datos del cliente incompletos." }, 400);
    }
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 60) {
      return json({ error: "El pedido no tiene productos." }, 400);
    }

    // Si el menú ya está guardado, los nombres y precios salen de ahí, no del navegador.
    const menuStore = getStore("menu");
    const menu = await menuStore.get("productos", { type: "json" });
    const porId = new Map((menu || []).map((p) => [p.id, p]));
    const promos = (await menuStore.get("promos", { type: "json" })) || [];
    const promoPorId = new Map(promos.map((p) => [100000 + p.id, p]));
    const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });

    const items = [];
    for (const it of b.items) {
      const qty = Number(it?.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 50) continue;

      // Las promociones llevan id 100000 + su número y se validan contra la fecha de hoy.
      if (Number(it?.id) >= 100000) {
        const pr = promoPorId.get(Number(it.id));
        if (!pr) return json({ error: "Una promoción de tu pedido ya no está disponible. Quítala e inténtalo de nuevo." }, 409);
        if (pr.activa === false || (pr.hasta && pr.hasta < hoy)) {
          return json({ error: `La promoción "${pr.nombre}" ya terminó. Quítala de tu pedido e inténtalo de nuevo.` }, 409);
        }
        items.push({ id: Number(it.id), nombre: str("Promo: " + pr.nombre, 80), precio: Number(pr.precio), qty });
        continue;
      }

      const real = porId.get(Number(it.id));
      if (menu && !real) continue;
      const nombre = str(real ? real.nombre : it.nombre, 80);
      const precio = real ? Number(real.precio) : Math.min(100000, Math.max(0, Number(it.precio) || 0));
      if (!nombre) continue;
      items.push({ id: Number(it.id) || 0, nombre, precio, qty });
    }
    if (!items.length) return json({ error: "El pedido no tiene productos válidos." }, 400);

    const total = Math.round(items.reduce((s, i) => s + i.precio * i.qty, 0) * 100) / 100;
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    const key = `p-${Date.now()}-${rand}`;
    const folio = rand;

    const pedido = {
      key,
      folio,
      fecha: new Date().toISOString(),
      cliente,
      pago: str(b.pago, 120),
      notas: str(b.notas, 300),
      items,
      total,
    };
    // Primero se guarda: el pedido no se pierde aunque Telegram falle.
    await store.setJSON(key, pedido);

    const avisado = await avisarTelegram(pedido);
    return json({ ok: true, folio, avisado });
  }

  // ---------- Administrador: consultar y borrar ----------
  if (!process.env.ADMIN_PASSWORD) return json({ error: "Falta configurar ADMIN_PASSWORD en Netlify." }, 500);
  if (!autorizado(req)) return json({ error: "Contraseña incorrecta." }, 401);

  if (req.method === "GET") {
    const { blobs } = await store.list({ prefix: "p-" });
    const keys = blobs.map((x) => x.key).sort().reverse().slice(0, 2000);
    const pedidos = [];
    for (let i = 0; i < keys.length; i += 25) {
      const lote = await Promise.all(keys.slice(i, i + 25).map((k) => store.get(k, { type: "json" })));
      pedidos.push(...lote.filter(Boolean));
    }
    return json({ pedidos });
  }

  if (req.method === "DELETE") {
    const key = new URL(req.url).searchParams.get("key") || "";
    if (!/^p-\d+-[A-Z0-9]+$/.test(key)) return json({ error: "Pedido inválido." }, 400);
    await store.delete(key);
    return json({ ok: true });
  }

  return json({ error: "Método no permitido." }, 405);
};

export const config = { path: "/api/pedidos" };
