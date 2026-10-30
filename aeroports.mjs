// Prépare la couche mondiale des aéroports pour tippecanoe.
// Entrée : GeoJSON séquentiel d'osmium (stdin). Sortie : une entité GeoJSON par ligne (stdout).
import { createInterface } from "node:readline";

const CARGO = /cargo|fret|freight|fedex|ups\b|dhl|atlas air|kalitta/i;
const GARDES = new Set([
  "apron", "terminal", "hangar", "helipad", "aerodrome", "taxiway", "taxilane", "runway", "stopway",
  "gate", "parking_position", "holding_position", "jet_bridge", "tower",
]);
const LINEAIRES = new Set(["taxiway", "taxilane", "runway", "stopway", "jet_bridge", "holding_position"]);

const vus = new Set();
const entites = [];
const pistes = new Map();

const contour = (g) => (g.type === "Polygon" ? g.coordinates[0] : g.type === "MultiPolygon" ? g.coordinates[0][0] : null);

for await (const brut of createInterface({ input: process.stdin })) {
  const ligne = brut.replace(/^\x1e/, "").trim();
  if (ligne === "") continue;
  const f = JSON.parse(ligne);
  // Un aéroport à cheval sur deux régions arrive deux fois : l'identifiant OSM tranche.
  if (f.id !== undefined) {
    if (vus.has(f.id)) continue;
    vus.add(f.id);
  }
  const t = f.properties ?? {};
  if (!GARDES.has(t.aeroway) || f.geometry === null) continue;
  const proprietes = {
    aeroway: t.aeroway,
    ref: t.ref ?? "",
    name: t["name:en"] ?? t.name ?? "",
    label: t.ref || t["name:en"] || t.name || t.iata || "",
    cargo: CARGO.test(`${t.name ?? ""} ${t.ref ?? ""} ${t.operator ?? ""} ${t.apron ?? ""} ${t.cargo ? "cargo" : ""}`),
  };
  let g = f.geometry;
  // osmium voit une surface dans tout chemin fermé : une boucle de taxiway reste une ligne.
  if (LINEAIRES.has(t.aeroway) && t.area !== "yes" && contour(g) !== null) {
    g = { type: "LineString", coordinates: contour(g) };
  }
  entites.push({ type: "Feature", properties: proprietes, geometry: g });
  if ((t.aeroway === "parking_position" || t.aeroway === "gate") && g.type === "LineString") {
    entites.push({ type: "Feature", properties: proprietes, geometry: { type: "Point", coordinates: g.coordinates[Math.floor(g.coordinates.length / 2)] } });
  }
  if (t.aeroway === "runway" && t.ref && g.type === "LineString") {
    const debut = g.coordinates[0];
    const finale = g.coordinates[g.coordinates.length - 1];
    const proche = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.005;
    // Une piste peut être découpée en tronçons dans OSM : les numéros vont aux extrémités du groupe.
    if (!pistes.has(t.ref)) pistes.set(t.ref, []);
    const memes = pistes.get(t.ref);
    const groupe = memes.find((bouts) => bouts.some((b) => proche(b, debut) || proche(b, finale)));
    if (groupe) groupe.push(debut, finale);
    else memes.push([debut, finale]);
  }
}

let nombrePistes = 0;
for (const [ref, groupes] of pistes) {
  for (const bouts of groupes) {
    nombrePistes += 1;
    let a = bouts[0];
    let b = bouts[1];
    let max = 0;
    for (const p of bouts) {
      for (const q of bouts) {
        const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (d > max) {
          max = d;
          a = p;
          b = q;
        }
      }
    }
    const lat = (a[1] * Math.PI) / 180;
    const cap = ((Math.atan2((b[0] - a[0]) * Math.cos(lat), b[1] - a[1]) * 180) / Math.PI + 360) % 360;
    const parties = ref.split("/");
    // Le sens de dessin dans OSM est quelconque : le seuil « 13 » est celui d'où l'on décolle au cap 130.
    const ecart = (r) => {
      const d = Math.abs(Number.parseInt(r, 10) * 10 - cap) % 360;
      return d > 180 ? 360 - d : d;
    };
    const [ra, rb] = parties.length === 2 && ecart(parties[1]) < ecart(parties[0]) ? [parties[1], parties[0]] : parties;
    const seuil = (r, pos, rot) => ({ type: "Feature", properties: { aeroway: "runway_end", ref: r, label: r, name: "", cargo: false, rot }, geometry: { type: "Point", coordinates: pos } });
    if (ra) entites.push(seuil(ra, a, cap));
    if (rb) entites.push(seuil(rb, b, (cap + 180) % 360));
  }
}

// OSM marque rarement un poste « cargo » : un poste posé sur une aire cargo l'est aussi.
// Grille de 0,1° pour ne pas comparer chaque poste à toutes les aires du monde.
const grille = new Map();
for (const f of entites) {
  if (!f.properties.cargo || f.geometry.type !== "Polygon") continue;
  const anneau = f.geometry.coordinates[0];
  const xs = anneau.map((p) => p[0]);
  const ys = anneau.map((p) => p[1]);
  for (let x = Math.floor(Math.min(...xs) * 10); x <= Math.floor(Math.max(...xs) * 10); x += 1) {
    for (let y = Math.floor(Math.min(...ys) * 10); y <= Math.floor(Math.max(...ys) * 10); y += 1) {
      const k = `${x}:${y}`;
      if (!grille.has(k)) grille.set(k, []);
      grille.get(k).push(anneau);
    }
  }
}
const dedans = (pt, anneau) => {
  let hit = false;
  for (let i = 0, j = anneau.length - 1; i < anneau.length; j = i++) {
    const [xi, yi] = anneau[i];
    const [xj, yj] = anneau[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};
let cargo = 0;
for (const f of entites) {
  if (f.geometry.type !== "Point" || !["parking_position", "gate"].includes(f.properties.aeroway)) continue;
  const [x, y] = f.geometry.coordinates;
  const candidats = grille.get(`${Math.floor(x * 10)}:${Math.floor(y * 10)}`) ?? [];
  if (f.properties.cargo || candidats.some((a) => dedans(f.geometry.coordinates, a))) {
    f.properties.cargo = true;
    cargo += 1;
  }
}
for (const f of entites) process.stdout.write(`${JSON.stringify(f)}\n`);
console.error(`${entites.length} entités, ${nombrePistes} pistes, ${cargo} postes cargo`);
