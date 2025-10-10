// /static/js/modules/HeatmapLayer.js
// Shim minimal : agrège faceId -> entityId puis colorise chaque entité selon sa valeur.
// Fonctionne avec xeokit: entity.colorize = [r,g,b,a] (0..1). Fallbacks prévus.

export default class HeatmapLayer {
  constructor(viewerAdapter) {
    this.adapter = viewerAdapter;
    this.viewer  = viewerAdapter?.viewer;
    this.scene   = this.viewer?.scene;
    this._original = new Map(); // sauvegarde des colorize pour reset éventuel
  }

  // Applique et retourne le nombre d'entités colorisées
  apply(map, opts = {}) {
    const { min = 0, max = 5, mode = "max" } = opts;
    const perEntity = {};

    // 1) regrouper par entité (clé "entityId:triIndex" -> "entityId")
    for (const [faceKey, raw] of Object.entries(map || {})) {
      const eid = String(faceKey).split(":")[0];
      const v = Number(raw) || 0;
      if (!(eid in perEntity)) perEntity[eid] = { sum: 0, n: 0, max: -Infinity };
      perEntity[eid].sum += v; perEntity[eid].n += 1; if (v > perEntity[eid].max) perEntity[eid].max = v;
    }

    // 2) valoriser une métrique par entité
    const valOf = (obj) => (mode === "avg" ? obj.sum / Math.max(1, obj.n) : obj.max);

    let applied = 0;
    for (const [eid, agg] of Object.entries(perEntity)) {
      const val = valOf(agg);
      const t = (val - min) / (max - min || 1);  // 0..1
      const rgba = HeatmapLayer.colorFromT(t);

      const node =
        this.scene?.objects?.[eid] ||
        this.scene?.meshes?.[eid]  ||
        this.scene?.components?.[eid] ||
        null;

      if (!node) continue;

      // Sauvegarde la couleur initiale une seule fois
      if (!this._original.has(eid)) {
        try {
          const cur = node.colorize || node._colorize || null;
          if (cur) this._original.set(eid, Array.from(cur));
        } catch {}
      }

      // 3) appliquer la colorisation (différentes APIs possibles selon build)
      try {
        if ("colorize" in node) {
          node.colorize = rgba;                     // xeokit standard
          applied++;
        } else if (typeof this.scene?.setObjectsColorize === "function") {
          this.scene.setObjectsColorize([eid], rgba);
          applied++;
        } else if (typeof this.adapter?.colorizeEntity === "function") {
          this.adapter.colorizeEntity(eid, rgba);
          applied++;
        }
      } catch (e) {
        // ignore
      }
    }

    // compteur diag pour l'orchestrateur
    this.debugAppliedCount = applied;
    return applied;
  }

  // Même API que ci-dessus mais renvoie appliqués
  applyWithCount(map, opts) {
    return this.apply(map, opts);
  }

  // Palette: bleu -> vert -> jaune -> rouge (via HSL)
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
