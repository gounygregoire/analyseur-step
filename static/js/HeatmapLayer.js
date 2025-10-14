// /static/js/modules/HeatmapLayer.js — UTF-8 (NO BOM)
// Shim HeatmapLayer — colorise les entités selon une map faceId -> valeur.
// Formats acceptés pour faceId :
//   1) "<entityId>:<triIndex>"
//   2) "<triIndex>" (index global)
//   3) "f<triIndex>" ou "t<triIndex>" (ex: "f123", "T42")
//   4) "<entityId>" (valeur directe par entité)
// Supporte xeokit: node.colorize = [r,g,b,a] (0..1), + fallbacks (scene.setObjectsColorize / adapter.colorizeEntity)

export default class HeatmapLayer {
  constructor(viewerAdapter) {
    this.adapter = viewerAdapter;
    this.viewer  = viewerAdapter?.viewer;
    this.scene   = this.viewer?.scene;

    // sauvegarde des colorize initiales pour reset()
    this._original = new Map();

    // cache pour la résolution "<triIndex>" -> "<entityId>"
    this._triToEntity = null;
  }
  // Essaie de résoudre triOnlyKeysNeeded avec un offset (pour 0-based vs 1-based)
_tryResolveWithOffset(triOnlyKeysNeeded, offset, pending) {
  // construit un cache temporaire si besoin
  const map = this._buildTriToEntityIndex(new Set(
    Array.from(triOnlyKeysNeeded).map(t => t + offset).filter(t => t > 0)
  ), { debug: false, append: false });

  let hits = 0;
  for (const p of pending) {
    const eid = map[p.triIndex + offset];
    if (eid) { 
      if (!this._triToEntity) this._triToEntity = {};
      this._triToEntity[p.triIndex] = eid; // on stocke au vrai index demandé
      hits++;
    }
  }
  return hits;
}


  /**
   * Applique la heatmap.
   * @param {Object} map - { faceKey -> value }
   * @param {Object} opts - { min, max, mode, idResolver, debug }
   *  - mode: "max" | "avg" (aggrégation per-entity)
   *  - idResolver(faceKey): optionnel, renvoie un entityId à partir d'un faceKey
   * @returns {number} nb d'entités colorisées
   */
  apply(map, opts = {}) {
    if (!map || !this.scene) {
      this.debugAppliedCount = 0;
      return 0;
    }
    const { mode = "max", idResolver = null, debug = false } = opts;

    // borne min/max auto si non fournis
    const values = Object.values(map).map(Number).filter(v => Number.isFinite(v));
    let min = (typeof opts.min === "number") ? opts.min : (values.length ? Math.min(...values) : 0);
    let max = (typeof opts.max === "number") ? opts.max : (values.length ? Math.max(...values) : 1);
    if (min === max) { max = min + 1; } // évite division par zéro

    // 1) Première passe: séparer par type de faceKey
    const perEntityAgg = {};            // eid -> { sum, n, max }
    const triOnlyKeysNeeded = new Set();// triIndex => à résoudre
    const pending = [];                 // { triIndex, value }

    const note = (eid, v) => {
      if (!(eid in perEntityAgg)) perEntityAgg[eid] = { sum: 0, n: 0, max: -Infinity };
      perEntityAgg[eid].sum += v;
      perEntityAgg[eid].n   += 1;
      if (v > perEntityAgg[eid].max) perEntityAgg[eid].max = v;
    };

    const entityExists = (eid) =>
      !!(this.scene?.objects?.[eid] || this.scene?.meshes?.[eid] || this.scene?.components?.[eid]);

    for (const [faceKey, raw] of Object.entries(map)) {
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;

      const key = String(faceKey).trim();

      // priorité: resolver externe si fourni
      if (typeof idResolver === "function") {
        const rid = idResolver(key);
        if (rid) { note(String(rid), v); continue; }
      }

      // (4) clé = entityId directe
      if (entityExists(key)) {
        note(key, v);
        continue;
      }

      // (1) format "<entityId>:<triIndex>"
      const parts = key.split(":");
      if (parts.length >= 2 && parts[0]) {
        // on agrège par entité (peu importe le triIndex exact)
        note(parts[0], v);
        continue;
      }

      // (2) "<triIndex>" strict
      // (3) "f<triIndex>" ou "t<triIndex>"
      let tri = null;
      if (/^\d+$/.test(key)) {
        tri = parseInt(key, 10);
      } else {
        const m = key.match(/^[ft](\d+)$/i);
        if (m) tri = parseInt(m[1], 10);
      }

      if (Number.isFinite(tri)) {
        triOnlyKeysNeeded.add(tri);
        pending.push({ triIndex: tri, value: v });
      }
      // sinon: clé inconnue -> ignorée
    }

    // 2) Si on a des indexes "tri" simples, construire (ou réutiliser) le mapping tri -> entity
if (triOnlyKeysNeeded.size > 0) {
  if (!this._triToEntity) {
    this._triToEntity = this._buildTriToEntityIndex(triOnlyKeysNeeded, { debug });
  } else {
    const unknown = Array.from(triOnlyKeysNeeded).filter(t => !(t in this._triToEntity));
    if (unknown.length) {
      const extraSet = new Set(unknown);
      const more = this._buildTriToEntityIndex(extraSet, { debug, append: true });
      Object.assign(this._triToEntity, more);
    }
  }

  // Compte initial de résolutions
  let resolved = 0;
  for (const { triIndex } of pending) if (this._triToEntity[triIndex]) resolved++;

  // Si on a très peu de correspondances → on tente offset -1, puis +1
  if (resolved < Math.ceil(pending.length * 0.1)) {
    const hitNeg = this._tryResolveWithOffset(triOnlyKeysNeeded, -1, pending);
    resolved += hitNeg;
    if (resolved < Math.ceil(pending.length * 0.1)) {
      const hitPos = this._tryResolveWithOffset(triOnlyKeysNeeded, +1, pending);
      resolved += hitPos;
    }
    if (debug) console.debug("[HeatmapLayer] fallback offset: resolved =", resolved, "/", pending.length);
  }

  for (const { triIndex, value } of pending) {
    const eid = this._triToEntity[triIndex];
    if (eid) note(String(eid), value);
  }
}


    // 3) Appliquer la colorisation par entité
    const valOf = (obj) => (mode === "avg" ? obj.sum / Math.max(1, obj.n) : obj.max);
    let applied = 0;

    for (const [eid, agg] of Object.entries(perEntityAgg)) {
      const val = valOf(agg);
      const t = (val - min) / (max - min || 1); // 0..1
      const rgba = HeatmapLayer.colorFromT(t);

      const node =
        this.scene?.objects?.[eid] ||
        this.scene?.meshes?.[eid]  ||
        this.scene?.components?.[eid] ||
        this.viewer?.scene?.objects?.[eid] ||
        null;

      if (!node) { if (debug) console.debug("[HeatmapLayer] entity introuvable:", eid); continue; }

      // sauvegarder couleur d'origine une seule fois
      if (!this._original.has(eid)) {
        try {
          const cur = node.colorize || node._colorize || null;
          if (cur) this._original.set(eid, Array.from(cur));
        } catch {}
      }

      try {
        if ("colorize" in node) {
          node.colorize = rgba;             // xeokit standard
          applied++;
        } else if (typeof this.scene?.setObjectsColorize === "function") {
          this.scene.setObjectsColorize([eid], rgba);
          applied++;
        } else if (typeof this.adapter?.colorizeEntity === "function") {
          this.adapter.colorizeEntity(eid, rgba);
          applied++;
        }
      } catch (e) {
        if (debug) console.debug("[HeatmapLayer] échec colorize", eid, e);
      }
    }

    this.debugAppliedCount = applied;
    if (debug) console.debug("[HeatmapLayer] applied", applied, "entities");
    return applied;
  }

  // Alias compté (API attendue par l’orchestrateur)
  applyWithCount(map, opts) {
    return this.apply(map, opts);
  }

  /**
   * Restaure les colorisations d'origine des entités modifiées.
   */
  reset() {
    let restored = 0;
    for (const [eid, rgba] of this._original.entries()) {
      const node =
        this.scene?.objects?.[eid] ||
        this.scene?.meshes?.[eid]  ||
        this.scene?.components?.[eid] ||
        null;
      try {
        if (node && "colorize" in node) {
          node.colorize = rgba;
          restored++;
        } else if (node && typeof this.scene?.setObjectsColorize === "function") {
          this.scene.setObjectsColorize([eid], rgba);
          restored++;
        } else if (node && typeof this.adapter?.colorizeEntity === "function") {
          this.adapter.colorizeEntity(eid, rgba);
          restored++;
        }
      } catch {}
    }
    this._original.clear();
    return restored;
  }

  // ====== Mapping triIndex -> entityId (heuristique) ======
  _buildTriToEntityIndex(targetSet, { debug = false, append = false } = {}) {
    const scene = this.viewer?.scene;
    if (!scene) return {};

    const need = new Set(targetSet || []);
    const out = append ? (this._triToEntity || {}) : {};

    const arr = (x) => x?.data || x?.array || x || null;

    const collectMeshes = (sc) => {
      const ms = [];
      if (!sc) return ms;
      if (sc.meshes)  ms.push(...Object.values(sc.meshes));
      if (sc.objects) ms.push(...Object.values(sc.objects));
      if (sc._objects)ms.push(...Object.values(sc._objects));
      if (typeof sc.iterate === 'function') sc.iterate(o => ms.push(o));
      return ms.filter(Boolean);
    };

    const getGeomArrays = (m) => {
      const G = [
        m.geometry, m._geometry, m._mesh?.geometry, m._rendererMesh?.geometry,
        m._rendererNode?.geometry, m._state?.geometry
      ].filter(Boolean);
      for (const g of G) {
        let P = arr(g.positions || g._positions || g.vertexPositions || g._vertexPositions ||
                    g.decompressedPositions || g.positionsDecompressed || g._state?.positions);
        let I = arr(g.indices   || g._indices   || g.triangles       || g._triangles       || g._state?.indices);
        if (!P && typeof g.getPositions === 'function') { try { P = g.getPositions(); } catch {} }
        if (!I && typeof g.getIndices   === 'function') { try { I = g.getIndices();   } catch {} }
        P = arr(P); I = arr(I);
        if (P && I && P.length && I.length) return { P, I };
      }
      return null;
    };

    // Comptage séquentiel global des triangles (approx. __getFaces historique)
    const meshes = collectMeshes(scene);
    let triCounter = 0;
    const maxNeeded = need.size ? Math.max(...need) : -1;
    const resolved = new Set();

    outer:
    for (const m of meshes) {
      const gi = getGeomArrays(m);
      if (!gi) continue;
      const { I } = gi;
      const eid = String(m.id || m._id || m.entity?.id || m.objectId || m.nodeId || "");

      for (let i = 0; i < I.length - 2; i += 3) {
        triCounter++; // 1-based
        if (need.has(triCounter)) {
          out[triCounter] = eid;
          resolved.add(triCounter);
          if (resolved.size === need.size) break outer;
        }
        if (triCounter > maxNeeded && resolved.size === need.size) break outer;
      }
    }

    if (debug) console.debug("[HeatmapLayer] tri->entity built:", resolved.size, "/", need.size);
    return out;
  }

  // ====== Palette: bleu -> vert -> jaune -> rouge (HSL) ======
  static colorFromT(t) {
    const tt = Math.max(0, Math.min(1, t));
    const hue = (1 - tt) * 240; // 240 (bleu) -> 0 (rouge)
    const [r, g, b] = HeatmapLayer.hslToRgb(hue / 360, 1, 0.5);
    return [r / 255, g / 255, b / 255, 1];
  }

  static hslToRgb(h, s, l) {
    if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const r = hue2rgb(p, q, h + 1/3);
    const g = hue2rgb(p, q, h);
    const b = hue2rgb(p, q, h - 1/3);
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }
}
