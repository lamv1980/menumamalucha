import { getStore } from "@netlify/blobs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const str = (v, max) => String(v ?? "").trim().slice(0, max);
const safeUrl = (v) => {
  const s = str(v, 300);
  return /^(https?:\/\/|\/|[\w.\-\/]+$)/i.test(s) ? s : "";
};
const dinero = (v) => Math.max(0, Math.round((Number(v) || 0) * 100) / 100);

// Fecha de hoy en hora de México (AAAA-MM-DD), sin importar dónde corra el servidor.
export const hoyMX = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });

const autorizado = (req) => {
  const pass = process.env.ADMIN_PASSWORD;
  return Boolean(pass) && req.headers.get("x-admin-password") === pass;
};

export default async (req) => {
  const store = getStore("menu");
  const hoy = hoyMX();

  if (req.method === "GET") {
    const todas = (await store.get("promos", { type: "json" })) || [];
    // El administrador pide ?todas=1 para editar también las vencidas y pausadas.
    if (new URL(req.url).searchParams.get("todas") === "1") {
      if (!autorizado(req)) return json({ error: "Contraseña incorrecta." }, 401);
      return json({ promos: todas, hoy });
    }
    const vigentes = todas.filter((p) => p.activa !== false && (!p.hasta || p.hasta >= hoy));
    return json({ promos: vigentes, hoy });
  }

  if (req.method === "POST") {
    if (!process.env.ADMIN_PASSWORD) return json({ error: "Falta configurar ADMIN_PASSWORD en Netlify." }, 500);
    if (!autorizado(req)) return json({ error: "Contraseña incorrecta." }, 401);

    let body;
    try { body = await req.json(); } catch { return json({ error: "Datos inválidos." }, 400); }
    if (!Array.isArray(body.promos)) return json({ error: "Datos inválidos." }, 400);

    const prev = (await store.get("promos", { type: "json" })) || [];
    let ultimo = Number(await store.get("ultimoPromoId")) || Math.max(0, ...prev.map((p) => p.id || 0));
    const used = new Set();

    const clean = body.promos
      .slice(0, 50)
      .map((p) => {
        let id = Number.isInteger(p?.id) && p.id > 0 && p.id <= ultimo && p.id < 100000 ? p.id : 0;
        if (!id || used.has(id)) id = ++ultimo;
        used.add(id);
        const normal = dinero(p?.precioNormal);
        return {
          id,
          nombre: str(p?.nombre, 80),
          desc: str(p?.desc, 160),
          precio: dinero(p?.precio),
          precioNormal: normal > 0 ? normal : null,
          hasta: /^\d{4}-\d{2}-\d{2}$/.test(p?.hasta || "") ? p.hasta : "",
          emoji: str(p?.emoji, 8),
          imagen: safeUrl(p?.imagen),
          activa: p?.activa !== false,
        };
      })
      .filter((p) => p.nombre);

    await store.setJSON("promos", clean);
    await store.set("ultimoPromoId", String(ultimo));
    return json({ ok: true, guardadas: clean.length, promos: clean });
  }

  return json({ error: "Método no permitido." }, 405);
};

export const config = { path: "/api/promos" };
