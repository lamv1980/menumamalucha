import { getStore } from "@netlify/blobs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const autorizado = (req) => {
  const pass = process.env.ADMIN_PASSWORD;
  return Boolean(pass) && req.headers.get("x-admin-password") === pass;
};

const MAX_BYTES = 2_000_000;

export default async (req) => {
  const store = getStore("fotos");

  // Ver una foto (pública: la usan el menú y las promociones).
  if (req.method === "GET") {
    const id = new URL(req.url).searchParams.get("id") || "";
    if (!/^f-\d+-[a-z0-9]+\.jpg$/.test(id)) return new Response("No encontrada", { status: 404 });
    const data = await store.get(id, { type: "arrayBuffer" });
    if (!data) return new Response("No encontrada", { status: 404 });
    return new Response(data, {
      headers: {
        "content-type": "image/jpeg",
        // El nombre de cada foto es único, así que se puede guardar en caché mucho tiempo.
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }

  // Subir una foto (solo el administrador).
  if (req.method === "POST") {
    if (!process.env.ADMIN_PASSWORD) return json({ error: "Falta configurar ADMIN_PASSWORD en Netlify." }, 500);
    if (!autorizado(req)) return json({ error: "Contraseña incorrecta." }, 401);

    const buf = await req.arrayBuffer();
    if (buf.byteLength < 100) return json({ error: "La imagen está vacía." }, 400);
    if (buf.byteLength > MAX_BYTES) return json({ error: "La imagen pesa demasiado." }, 413);
    const b = new Uint8Array(buf);
    if (!(b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)) return json({ error: "Solo se aceptan fotos JPG." }, 400);

    const key = `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    await store.set(key, buf);
    return json({ ok: true, url: `/api/foto?id=${key}` });
  }

  return json({ error: "Método no permitido." }, 405);
};

export const config = { path: "/api/foto" };
