/* /static/js/criteria-modal.js — logique matériaux + conflits + scoring */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ------------------------- Mini base matières ------------------------- *
   * nb: valeurs typées “ordre de grandeur” pour démontrer la logique.
   * Tu pourras enrichir/affiner ou charger depuis ton backend.
   * --------------------------------------------------------------------- */
  const MATERIALS = [
    {
      id: "PP",
      name: "PP (polypropylène)",
      cat: "semi-cristallin",
      E_GPa: 1.5,
      izod_kJm2: 6,
      Tg_C: -10,
      HDT_C: 55,
      CTI: 600,
      UL94: "HB",
      price_eurkg: 2.5,
      transparent: false,
      uv_ok: "moyen",
      chem: ["huiles", "detergents"],
      food: true,
      medical: false,
      fr_grade: false,
      min_wall_mm: 1.2,
      elongation_pct: 300,
      hinge_ok: true,
      snap_ok: true,
      overmold_ok: true,
    },
    {
      id: "PP_GF30",
      name: "PP GF30",
      cat: "semi-cristallin",
      E_GPa: 4.5,
      izod_kJm2: 5,
      Tg_C: -10,
      HDT_C: 95,
      CTI: 600,
      UL94: "HB",
      price_eurkg: 3.6,
      transparent: false,
      uv_ok: "moyen",
      chem: ["huiles", "detergents"],
      food: false,
      medical: false,
      fr_grade: false,
      min_wall_mm: 1.5,
      elongation_pct: 2,
      hinge_ok: false,
      snap_ok: false,
      overmold_ok: true,
    },
    {
      id: "ABS",
      name: "ABS",
      cat: "amorphe",
      E_GPa: 2.1,
      izod_kJm2: 18,
      Tg_C: 100,
      HDT_C: 85,
      CTI: 250,
      UL94: "HB",
      price_eurkg: 2.8,
      transparent: false,
      uv_ok: "faible",
      chem: ["alcool"],
      food: false,
      medical: false,
      fr_grade: false,
      min_wall_mm: 1.2,
      elongation_pct: 20,
      hinge_ok: false,
      snap_ok: true,
      overmold_ok: true,
    },
    {
      id: "PC",
      name: "PC transparent (UV)",
      cat: "amorphe",
      E_GPa: 2.4,
      izod_kJm2: 70,
      Tg_C: 145,
      HDT_C: 120,
      CTI: 250,
      UL94: "V-2",
      price_eurkg: 5.2,
      transparent: true,
      uv_ok: "fort",
      chem: ["alcool", "detergents"],
      food: true,
      medical: false,
      fr_grade: false,
      min_wall_mm: 2.0,
      elongation_pct: 120,
      hinge_ok: false,
      snap_ok: true,
      overmold_ok: true,
    },
    {
      id: "PCABS_FR",
      name: "PC-ABS FR (V-0)",
      cat: "amorphe-blend",
      E_GPa: 2.3,
      izod_kJm2: 45,
      Tg_C: 115,
      HDT_C: 100,
      CTI: 250,
      UL94: "V-0",
      price_eurkg: 6.1,
      transparent: false,
      uv_ok: "moyen",
      chem: ["alcool", "detergents"],
      food: false,
      medical: false,
      fr_grade: true,
      min_wall_mm: 2.0,
      elongation_pct: 80,
      hinge_ok: false,
      snap_ok: true,
      overmold_ok: true,
    },
    {
      id: "PA6",
      name: "PA6 (nylon)",
      cat: "semi-cristallin",
      E_GPa: 2.6,
      izod_kJm2: 6,
      Tg_C: 50,
      HDT_C: 180,
      CTI: 600,
      UL94: "HB",
      price_eurkg: 3.2,
      transparent: false,
      uv_ok: "faible",
      chem: ["huiles"],
      food: true,
      medical: false,
      fr_grade: false,
      min_wall_mm: 1.2,
      elongation_pct: 60,
      hinge_ok: false,
      snap_ok: true,
      overmold_ok: true,
      absorbs_water: true,
    },
    {
      id: "PA66_GF30",
      name: "PA66 GF30",
      cat: "semi-cristallin",
      E_GPa: 7.0,
      izod_kJm2: 12,
      Tg_C: 70,
      HDT_C: 210,
      CTI: 600,
      UL94: "HB",
      price_eurkg: 4.4,
      transparent: false,
      uv_ok: "moyen",
      chem: ["huiles"],
      food: false,
      medical: false,
      fr_grade: false,
      min_wall_mm: 1.5,
      elongation_pct: 2,
      hinge_ok: false,
      snap_ok: false,
      overmold_ok: true,
      absorbs_water: true,
    },
    {
      id: "POM",
      name: "POM (acétal)",
      cat: "semi-cristallin",
      E_GPa: 2.8,
      izod_kJm2: 6,
      Tg_C: -50,
      HDT_C: 100,
      CTI: 600,
      UL94: "HB",
      price_eurkg: 3.9,
      transparent: false,
      uv_ok: "faible",
      chem: ["huiles", "solvants"],
      food: true,
      medical: false,
      fr_grade: false,
      min_wall_mm: 1.0,
      elongation_pct: 40,
      hinge_ok: false,
      snap_ok: true,
      overmold_ok: true,
    },
    {
      id: "PBT_GF30",
      name: "PBT GF30",
      cat: "semi-cristallin",
      E_GPa: 8.0,
      izod_kJm2: 10,
      Tg_C: 50,
      HDT_C: 200,
      CTI: 600,
      UL94: "V-2",
      price_eurkg: 4.6,
      transparent: false,
      uv_ok: "moyen",
      chem: ["huiles", "alcool"],
      food: false,
      medical: false,
      fr_grade: false,
      min_wall_mm: 1.2,
      elongation_pct: 3,
      hinge_ok: false,
      snap_ok: false,
      overmold_ok: true,
    },
    {
      id: "PPSU",
      name: "PPSU (médical stérilisable)",
      cat: "amorphe hautes perfs",
      E_GPa: 2.4,
      izod_kJm2: 9,
      Tg_C: 220,
      HDT_C: 200,
      CTI: 250,
      UL94: "V-0",
      price_eurkg: 22,
      transparent: translucide(),
      uv_ok: "moyen",
      chem: ["alcool", "detergents"],
      food: true,
      medical: true,
      fr_grade: true,
      min_wall_mm: 2.0,
      elongation_pct: 60,
      hinge_ok: false,
      snap_ok: true,
      overmold_ok: false,
      sterilize_ok: true,
    },
    {
      id: "PEEK",
      name: "PEEK",
      cat: "semi-cristallin hautes perfs",
      E_GPa: 3.6,
      izod_kJm2: 5,
      Tg_C: 143,
      HDT_C: 250,
      CTI: 600,
      UL94: "V-0",
      price_eurkg: 45,
      transparent: false,
      uv_ok: "moyen",
      chem: ["huiles", "solvants", "detergents"],
      food: true,
      medical: true,
      fr_grade: true,
      min_wall_mm: 1.0,
      elongation_pct: 20,
      hinge_ok: false,
      snap_ok: true,
      overmold_ok: false,
      sterilize_ok: true,
    },
  ];

  function translucide(){ return false; } // placeholder simple

  /* ----------------------------- Presets UI ----------------------------- */
  const PRESETS = {
    outdoor_uv: (f) => {
      f.expoUV.checked = true;
      $("#transparence").checked = false;
      $("#rigidite_elevee").checked = true;
      setPriority("rigidite_elevee", "should");
      $("#resistance_chocs").checked = true;
      setPriority("resistance_chocs", "must");
      $("#prixCible").value = 5; updateRangeLabel("#prixCible", "#prixCibleVal", "€ /kg");
      $("#ul94").value = ""; // indifférent
      $("#process").value = "injection";
      $("#epMin").value = 2;
    },
    clip_flexible: (f) => {
      $("#flexibilite").checked = true; setPriority("flexibilite", "must");
      $("#resistance_chocs").checked = true; setPriority("resistance_chocs", "should");
      $("#features").value = ["snapfits"];
      $("#epMin").value = 1.2;
      $("#prixCible").value = 6; updateRangeLabel("#prixCible", "#prixCibleVal", "€ /kg");
      $("#process").value = "injection";
    },
    medical_sterile: (f) => {
      $("#qualite_medicale").checked = true;
      $("#contact_alimentaire").checked = true;
      $("#ul94").value = "V-0";
      $("#tempServiceMax").value = 120; updateRangeLabel("#tempServiceMax", "#tempServiceMaxVal", "°C");
      $("#prixCible").value = 20; updateRangeLabel("#prixCible", "#prixCibleVal", "€ /kg");
      $("#process").value = "injection";
    },
    charniere_film: (f) => {
      $("#flexion").checked = true; setPriority("flexion", "must");
      $("#flexibilite").checked = true; setPriority("flexibilite", "must");
      $("#epMin").value = 0.8;
      $("#process").value = "injection";
      $("#prixCible").value = 4; updateRangeLabel("#prixCible", "#prixCibleVal", "€ /kg");
    },
    optique_transparente: (f) => {
      $("#transparence").checked = true; setPriority("transparence", "must");
      $("#ul94").value = ""; // variable
      $("#resistance_chocs").checked = true; setPriority("resistance_chocs", "should");
      $("#epMin").value = 2;
      $("#prixCible").value = 8; updateRangeLabel("#prixCible", "#prixCibleVal", "€ /kg");
    },
    electrique_cti: (f) => {
      $("#proprietes_elec").checked = true;
      $("#ul94").value = "V-2";
      $("#prixCible").value = 5; updateRangeLabel("#prixCible", "#prixCibleVal", "€ /kg");
      $("#process").value = "injection";
    },
  };

  function setPriority(id, val){
    const sel = $(`select.priority[data-for="${id}"]`);
    if (sel) sel.value = val;
  }

  /* -------------------------- Lecture du formulaire -------------------------- */
  function readForm(){
    const f = {
      // contexte usage
      tempMax: num($("#tempServiceMax")?.value, 60),
      uv: $("#expoUV")?.checked || false,
      humid: $("#expoHumidite")?.checked || false,
      chimie: getChemTags(),
      // reg & coût
      ul94: $("#ul94")?.value || "",
      prix: num($("#prixCible")?.value, 8),
      region: $("#regionConformite")?.value || "",
      // process & pièce
      process: $("#process")?.value || "injection",
      epMin: num($("#epMin")?.value, null),
      features: Array.from($("#features")?.selectedOptions || []).map(o=>o.value),
      // critères binaires + priorité
      criteria: collectCriteria()
    };
    return f;
  }
  function num(v, d){ const n = parseFloat(v); return isFinite(n) ? n : d; }
  function getChemTags(){
    const m = [];
    if ($("#chem_huiles")?.checked) m.push("huiles");
    if ($("#chem_solvents")?.checked) m.push("solvants");
    if ($("#chem_alcool")?.checked) m.push("alcool");
    if ($("#chem_detergents")?.checked) m.push("detergents");
    if ($("#chem_eausalee")?.checked) m.push("eausalee");
    return m;
  }
  function collectCriteria(){
    const map = {};
    $$(".criterion").forEach(cb=>{
      const id = cb.id;
      if (!id) return;
      const pri = $(`select.priority[data-for="${id}"]`)?.value || "should";
      map[id] = { on: cb.checked, pri };
    });
    return map;
  }

  /* ----------------------- Règles de conflits (UI) ----------------------- */
  function detectConflicts(f){
    const msg = [];

    // 1) rigidité élevée vs flexibilité (si Must tous les deux -> conflit)
    const rigid = f.criteria["rigidite_elevee"];
    const flexi = f.criteria["flexibilite"];
    if (rigid?.on && flexi?.on && rigid.pri === "must" && flexi.pri === "must"){
      msg.push("Rigidité élevée et Flexibilité ne peuvent pas être Must simultanément.");
    }

    // 2) Transparence stricte (Must) vs remplissage verre (GF) -> materials transparent ≠ GF
    const transp = f.criteria["transparence"];
    if (transp?.on && transp.pri === "must"){
      msg.push("Transparence stricte : exclut les grades chargés (GF) et fortement pigmentés.");
    }

    // 3) Charnière film requiert Flexibilité Must + épaisseur faible
    const hinge = f.features.includes("hinge");
    if (hinge){
      if (!(flexi?.on)) msg.push("Charnière film : active Flexibilité (au moins Should).");
      if (f.epMin !== null && f.epMin > 1.0) msg.push("Charnière film : épaisseur min conseillée ≤ 1.0 mm.");
    }

    // 4) Encliquetages → allongement ≥4% (évite GF raide / cassant)
    const snap = f.features.includes("snapfits");
    if (snap && rigid?.pri === "must"){
      msg.push("Encliquetages : éviter **rigidité Must** avec grades fibre de verre (cassant).");
    }

    // 5) UL94 V-0 + Transparence Must -> très peu d’options (attention) 
    if (f.ul94 === "V-0" && transp?.on && transp.pri === "must"){
      msg.push("UL94 V-0 + Transparence Must : combinaisons rares (PC traité, PSU/PESU/PPSU translucides).");
    }

    // 6) Exposition UV + ABS standard -> avertir (géré plus bas au scoring)
    if (f.uv) msg.push("Exposition UV : préférer PC UV / ASA / POM stabilisé / PA avec additifs.");

    // 7) Température service très élevée >150°C -> restreint (PPSU/PEEK/PAI…)
    if (f.tempMax > 150) msg.push("Température service >150°C : restreint aux polymers hautes perfs (PPSU, PEEK…).");

    return msg;
  }

  /* ------------------------- Scoring & filtrage ------------------------- */
  function satisfiesUL94(matUL, req){
    if (!req) return true;
    const order = ["HB","V-2","V-1","V-0"];
    const im = order.indexOf(matUL);
    const ir = order.indexOf(req);
    return im >= 0 && ir >= 0 && im >= ir; // mat rating is equal or better
  }

  function distance(a,b,scale){ return Math.max(0, (a - b) / (scale || 1)); }

  function scoreMaterial(m, f){
    // Hard filters (exclusions)
    if (f.ul94 && !satisfiesUL94(m.UL94, f.ul94)) return {pass:false, why:["UL94 insuffisant"]};
    if (f.uv && m.uv_ok === "faible") return {pass:false, why:["UV faible"]};
    if (f.epMin !== null && f.epMin < m.min_wall_mm) return {pass:false, why:[`Epaisseur min ${f.epMin} < ${m.min_wall_mm} mm`]};
    if (f.region === "US" && m.food === false && f.criteria["contact_alimentaire"]?.on) {
      return {pass:false, why:["Food grade requis (US)"]};
    }
    if (f.criteria["qualite_medicale"]?.on && !m.medical) {
      return {pass:false, why:["Qualité médicale requise"]};
    }
    if (f.criteria["retardateur_flamme"]?.on && !m.fr_grade && f.ul94==="" ) {
      // si "retardateur de flamme" coché mais pas de seuil UL94 : exiger mat.fr_grade
      return {pass:false, why:["Grade FR requis"]};
    }
    if (f.criteria["transparence"]?.pri === "must" && !m.transparent){
      return {pass:false, why:["Transparence Must non satisfaite"]};
    }

    // Must − spécifiques
    const musts = [];
    for (const [key, spec] of Object.entries(f.criteria)) {
      if (!spec.on || spec.pri!=="must") continue;
      if (key==="rigidite_elevee" && m.E_GPa < 2.2) { return {pass:false, why:["Rigidité Must non atteinte"]}; }
      if (key==="flexibilite" && m.elongation_pct < 50) { return {pass:false, why:["Flexibilité Must non atteinte"]}; }
      if (key==="resistance_chocs" && m.izod_kJm2 < 20) { return {pass:false, why:["Choc Must non atteint"]}; }
      if (key==="flexion" && m.hinge_ok===false && f.features.includes("hinge")) { return {pass:false, why:["Charnière film incompatible"]}; }
      if (key==="traction") { /* rien de spécifique sans seuil */ }
      if (key==="usure" && m.cat==="amorphe" && !m.chem.includes("huiles")) { return {pass:false, why:["Usure: préférer semi-cristallin (POM/PA/PBT)"]}; }
      if (key==="fatigue" && m.snap_ok===false) { return {pass:false, why:["Fatigue: éviter grades cassants"]}; }
      musts.push(key);
    }

    // Score de base
    let score = 100;
    const why = [];

    // Température
    if (f.tempMax){
      if (m.HDT_C < f.tempMax) { score -= 25; why.push(`HDT ${m.HDT_C} < Temp req ${f.tempMax}`); }
      else { score += 5; }
    }

    // UV
    if (f.uv){
      if (m.uv_ok==="fort") score += 10; else if (m.uv_ok==="moyen") score += 2; else { score -= 20; why.push("UV faible"); }
    }

    // Chimie
    for (const c of f.chimie){
      if (c==="eausalee" && m.cat==="amorphe") { score -= 10; why.push("Amorphe & eau salée"); }
      if (!m.chem.includes(c)) { score -= 6; why.push(`Résistance chimie limitée (${c})`); }
      else score += 2;
    }

    // Prix (objectif “au plus proche”, pénalité relative)
    if (f.prix){
      const ratio = Math.abs(m.price_eurkg - f.prix) / Math.max(f.prix, 1);
      score -= Math.min(20, 20*ratio);
      if (ratio<0.15) score += 5;
    }

    // Process
    if (f.process==="injection"){ score += 0; } // tous compatibles ici
    if (f.process==="impression3d" && m.id!=="PC" && m.id!=="ABS") { score -= 5; why.push("Filière 3D limitée"); } // simplifié
    if (f.process==="usinage" && m.cat==="amorphe") { score -= 5; why.push("Usinage: préférer semi-cristallin"); }

    // Features
    if (f.features.includes("snapfits")){
      if (m.snap_ok) score += 6; else { score -= 12; why.push("Snap-fit déconseillé"); }
      if (m.elongation_pct < 4) { score -= 15; why.push("Allongement <4% pour snap-fit"); }
    }
    if (f.features.includes("hinge")){
      if (m.hinge_ok) score += 10; else { score -= 18; why.push("Charnière film non adaptée"); }
    }
    if (f.features.includes("transparent")){
      if (m.transparent) score += 10; else { score -= 25; why.push("Transparent requis"); }
    }
    if (f.features.includes("overmold") && !m.overmold_ok){ score -= 10; why.push("Surmoulage délicat"); }

    // Critères Should / Nice
    for (const [key, spec] of Object.entries(f.criteria)) {
      if (!spec.on) continue;
      const pen = spec.pri==="should" ? 6 : 3;
      switch (key){
        case "rigidite_elevee": if (m.E_GPa < 2.2) score -= pen; else score += 2; break;
        case "flexibilite": if (m.elongation_pct < 50) score -= pen; else score += 2; break;
        case "resistance_chocs": if (m.izod_kJm2 < 20) score -= pen; else score += 2; break;
        case "flexion": if (!m.hinge_ok && f.features.includes("hinge")) score -= pen; break;
        case "traction": /* pas de métrique simple ici */ break;
        case "usure": if (m.cat==="amorphe") score -= pen; else score += 1; break;
        case "fatigue": if (!m.snap_ok) score -= pen; else score += 1; break;
        case "qualite_surface": if (m.cat==="semi-cristallin") score -= 1; break;
        case "transparence": if (!m.transparent) score -= pen; break;
        case "texture_possible": /* neutre */ break;
        case "finition_bril": if (m.cat==="semi-cristallin") score -= 1; break;
      }
    }

    // Bonus conformité
    if (f.criteria["contact_alimentaire"]?.on && m.food) score += 5;
    if (f.criteria["proprietes_elec"]?.on && m.CTI>=600) score += 6;

    // UL94 stricte déjà gérée en hard filter; sinon un peu de bonus
    if (f.ul94 && satisfiesUL94(m.UL94, f.ul94)) score += 4;

    return { pass:true, score, why };
  }

  /* --------------------------- Rendu de shortlist --------------------------- */
  function renderShortlist(f, results){
    const cont = $("#materialShortlist");
    const cards = $("#shortlistCards");
    const whyDiv = $("#whyReco");
    cards.innerHTML = "";

    results.slice(0,3).forEach(r=>{
      const m = r.mat;
      const el = document.createElement("div");
      el.className = "col-12 col-md-4";
      el.innerHTML = `
        <div class="card h-100">
          <div class="card-body">
            <h6 class="card-title">${m.name}</h6>
            <div class="small text-muted mb-2">Score: <b>${r.score.toFixed(0)}</b></div>
            <ul class="small mb-2">
              <li>E ≈ ${m.E_GPa} GPa • Izod ≈ ${m.izod_kJm2} kJ/m²</li>
              <li>HDT ≈ ${m.HDT_C} °C • UL94 ${m.UL94}</li>
              <li>Prix ≈ ${m.price_eurkg} €/kg • CTI ${m.CTI}</li>
            </ul>
            <div class="small text-muted">Atouts: ${summarizeMat(m)}</div>
          </div>
        </div>`;
      cards.appendChild(el);
    });

    whyDiv.innerHTML = `
      <div><b>Règles appliquées :</b></div>
      <ul class="small">
        ${detectConflicts(f).map(x=>`<li>${escapeHTML(x)}</li>`).join("")}
      </ul>
    `;

    cont.classList.remove("d-none");
  }

  function summarizeMat(m){
    const tags = [];
    if (m.transparent) tags.push("transparent");
    if (m.uv_ok==="fort") tags.push("UV+");
    if (m.food) tags.push("alimentaire");
    if (m.medical) tags.push("médical");
    if (m.fr_grade) tags.push("FR");
    if (m.snap_ok) tags.push("snap-fit");
    if (m.hinge_ok) tags.push("charnière");
    return tags.join(", ") || "—";
  }

  function escapeHTML(s){ return s.replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  /* -------------------------- Résumé / Avertissements -------------------------- */
  function updateSummaryAndConflicts(f){
    const confs = detectConflicts(f);
    const warnEl = $("#criteriaConflicts");
    if (confs.length){
      warnEl.classList.remove("d-none");
      warnEl.innerHTML = `<i class="bi bi-exclamation-triangle me-2"></i>${escapeHTML(confs[0])}${confs.length>1?` (+${confs.length-1} autres)`:``}`;
    } else {
      warnEl.classList.add("d-none");
    }

    const counts = {ok:0,warn:confs.length,block:0};
    // block = si 2 Must incompatibles détectés (déjà traité dans confs)
    $("#critOK").textContent = `Validés: ${counts.ok}`;
    $("#critWARN").textContent = `Avertissements: ${counts.warn}`;
    $("#critBLOCK").textContent = `Bloquants: ${counts.block}`;
  }

  /* ------------------------------- Helpers UI ------------------------------- */
  function updateRangeLabel(rangeSel, labelSel, suffix){
    const r = $(rangeSel), lab = $(labelSel);
    if (r && lab) lab.textContent = `${r.value}${suffix}`;
  }

  /* -------------------------------- Handlers -------------------------------- */
  document.addEventListener("DOMContentLoaded", () => {
    // Libellés sliders
    updateRangeLabel("#tempServiceMax", "#tempServiceMaxVal", "°C");
    updateRangeLabel("#prixCible", "#prixCibleVal", " €/kg");
    $("#tempServiceMax")?.addEventListener("input", ()=>updateRangeLabel("#tempServiceMax", "#tempServiceMaxVal", "°C"));
    $("#prixCible")?.addEventListener("input", ()=>updateRangeLabel("#prixCible", "#prixCibleVal", " €/kg"));

    // Presets
    $("#materialPreset")?.addEventListener("change", (e)=>{
      const f = document.forms.materialQuestionnaireForm;
      const v = e.target.value;
      if (PRESETS[v]) PRESETS[v](f);
      updateSummaryAndConflicts(readForm());
    });

    // Toute modif met à jour le résumé
    $("#materialQuestionnaireForm")?.addEventListener("input", ()=>{
      updateSummaryAndConflicts(readForm());
    });

    // Bouton principal
    $("#materialConfirmBtn")?.addEventListener("click", ()=>{
      const f = readForm();
      updateSummaryAndConflicts(f);
      
      // ... à la fin du handler du click sur #materialConfirmBtn
      const conflicts = detectConflicts(f);

      // Fermer la modale
      const modalEl = document.getElementById('materialModal');
      bootstrap.Modal.getInstance(modalEl)?.hide();

      // Émettre un event global pour le viewer / panneau démoulage
      window.dispatchEvent(new CustomEvent('cadlytics:material-analysis-done', {
        detail: {
          conflicts,
          hasConflicts: (conflicts?.length || 0) > 0,
          shortlist: (results || []).slice(0,3).map(r => ({ id: r.mat.id, score: r.score }))
        }
      }));


      // Score et tri
      const results = MATERIALS.map(mat=>{
        const r = scoreMaterial(mat, f);
        return {mat, ...r};
      }).filter(r=>r.pass).sort((a,b)=>b.score-a.score);

      if (!results.length){
        $("#materialShortlist")?.classList.remove("d-none");
        $("#shortlistCards").innerHTML = `<div class="col-12"><div class="alert alert-danger small">Aucune matière ne satisfait les contraintes. Allège les Must ou ajuste les seuils.</div></div>`;
        $("#whyReco").innerHTML = `<div class="small text-muted">Essaie de réduire les Must et/ou d’augmenter le prix cible / baisser Température service.</div>`;
        return;
      }
      renderShortlist(f, results);
    });
  });
})();
