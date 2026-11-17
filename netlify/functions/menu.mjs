import { getStore } from "@netlify/blobs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const str = (v, max) => String(v ?? "").trim().slice(0, max);

// Acepta http(s), rutas que empiezan con "/" o nombres de archivo simples.
const safeUrl = (v) => {
  const s = str(v, 300);
  return /^(https?:\/\/|\/|[\w.\-\/]+$)/i.test(s) ? s : "";
};

export default async (req) => {
  const store = getStore("menu");

  if (req.method === "GET") {
    const productos = await store.get("productos", { type: "json" });
    return json({ productos: productos || null });
  }

  if (req.method === "POST") {
    const pass = process.env.ADMIN_PASSWORD;
    if (!pass) return json({ error: "Falta configurar ADMIN_PASSWORD en Netlify." }, 500);
    if (req.headers.get("x-admin-password") !== pass) {
      return json({ error: "Contraseña incorrecta." }, 401);
    }

    let body;
    try { body = await req.json(); } catch { return json({ error: "Datos inválidos." }, 400); }

    if (body.action === "login") return json({ ok: true });

    if (!Array.isArray(body.productos)) return json({ error: "Datos inválidos." }, 400);

    // Cada producto tiene un número (id) que no cambia nunca y que nunca se reutiliza,
    // aunque borres productos. Así las ventas de uno no se mezclan con otro.
    const prev = (await store.get("productos", { type: "json" })) || [];
    let ultimo = Number(await store.get("ultimoId")) || Math.max(0, ...prev.map((p) => p.id || 0));
    const used = new Set();

    const clean = body.productos
      .slice(0, 300)
      .map((p) => {
        let id = Number.isInteger(p?.id) && p.id > 0 && p.id <= ultimo ? p.id : 0;
        if (!id || used.has(id)) id = ++ultimo;
        used.add(id);
        return {
          id,
          nombre: str(p?.nombre, 80),
          desc: str(p?.desc, 160),
          categoria: str(p?.categoria, 40) || "Otros",
          precio: Math.max(0, Math.round((Number(p?.precio) || 0) * 100) / 100),
          emoji: str(p?.emoji, 8),
          imagen: safeUrl(p?.imagen),
          disponible: p?.disponible !== false,
        };
      })
      .filter((p) => p.nombre);

    if (!clean.length) return json({ error: "Agrega al menos un producto con nombre." }, 400);

    await store.setJSON("productos", clean);
    await store.set("ultimoId", String(ultimo));
    return json({ ok: true, guardados: clean.length, productos: clean });
  }

  return json({ error: "Método no permitido." }, 405);
};

export const config = { path: "/api/menu" };
