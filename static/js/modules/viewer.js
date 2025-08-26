import {
    Viewer,
    XKTLoaderPlugin,
    EdgesPlugin,
    SectionPlanesPlugin,
    DistanceMeasurementsPlugin,
    AnnotationsPlugin
} from "@xeokit/xeokit-sdk";

// Gestionnaire de visualisation avec swap preview/final + overlay DFM
export class XeokitModelViewer extends EventTarget {
    constructor(canvasId) {
        super();
        this.viewer = new Viewer({ canvasId });
        this.loader = new XKTLoaderPlugin(this.viewer);
        this.edges = new EdgesPlugin(this.viewer);
        this.sections = new SectionPlanesPlugin(this.viewer);
        this.measure = new DistanceMeasurementsPlugin(this.viewer);
        this.annotations = new AnnotationsPlugin(this.viewer, {});
        this.modelId = "model"; // identifiant constant pour swap
        this.previewUrl = null;
        this.finalUrl = null;
        this.currentQuality = null; // 'preview' | 'final'
        this.heatmapActive = false;
        this.colorBuffer = null; // stocke vertex/face colors
    }

    // --- chargement ---------------------------------------------------------
    async load(url, { quality = "preview" } = {}) {
        const cam = this.viewer.camera.getState();
        if (this.model) {
            this.model.destroy();
        }
        this.model = await this.loader.load({ id: this.modelId, src: url });
        if (this.currentQuality === null) {
            // première fois -> cadrage automatique
            this.viewer.cameraFlight.flyTo(this.model); 
            this.dispatchEvent(new CustomEvent("onAssetLoaded", { detail: { url } }));
        } else {
            // upgrade/downgrade -> restituer caméra
            this.viewer.camera.setState(cam);
            if (quality === "final") {
                this.dispatchEvent(new CustomEvent("onAssetUpgraded", { detail: { url } }));
            }
        }
        this.currentQuality = quality;
        if (this.heatmapActive && this.colorBuffer) {
            this._applyColors(this.colorBuffer);
        }
    }

    // --- polling ------------------------------------------------------------
    startPolling(apiId) {
        this.apiId = apiId;
        this._poll();
    }

    async _poll() {
        if (!this.apiId) return;
        try {
            const res = await fetch(`/api/models/${this.apiId}`);
            if (!res.ok) throw new Error("API");
            const data = await res.json();
            if (data.preview_ready && !this.previewUrl) {
                this.previewUrl = data.preview_url;
                await this.load(this.previewUrl, { quality: "preview" });
                this._setProgress(0.5);
            }
            if (data.final_ready && !this.finalUrl) {
                this.finalUrl = data.final_url;
                await this.load(this.finalUrl, { quality: "final" });
                this._setProgress(0.8);
            }
            if (data.dfm_ready) {
                this._setProgress(1);
            }
            if (!data.final_ready) {
                setTimeout(() => this._poll(), 1500);
            }
        } catch (e) {
            setTimeout(() => this._poll(), 1500);
        }
    }

    // --- qualité ------------------------------------------------------------
    async toggleQuality() {
        if (this.currentQuality === "preview" && this.finalUrl) {
            await this.load(this.finalUrl, { quality: "final" });
            return "final";
        } else if (this.previewUrl) {
            await this.load(this.previewUrl, { quality: "preview" });
            return "preview";
        }
    }

    // --- heatmap ------------------------------------------------------------
    applyHeatmap(buffer) {
        this.colorBuffer = buffer; // {vertexColors: Float32Array} ou {faceColors: Float32Array}
        this._applyColors(buffer);
        this.heatmapActive = true;
        this.dispatchEvent(new Event("onDFMOverlayToggled"));
    }

    _applyColors(buffer) {
        if (!this.model) return;
        this.model.meshes.forEach((m) => {
            const g = m.geometry;
            if (buffer.vertexColors) {
                g.setColors({ colors: buffer.vertexColors });
            } else if (buffer.faceColors) {
                g.setColors({ colors: buffer.faceColors, space: "faces" });
            }
        });
    }

    toggleHeatmap(on) {
        if (!this.model) return;
        if (on && this.colorBuffer) {
            this._applyColors(this.colorBuffer);
        } else {
            this.model.meshes.forEach((m) => m.geometry.setColors(null));
        }
        this.heatmapActive = on;
        this.dispatchEvent(new Event("onDFMOverlayToggled"));
    }

    // --- wireframe ----------------------------------------------------------
    toggleWireframe(on) {
        this.edges.enabled = on;
    }

    // --- DFM issues ---------------------------------------------------------
    setIssues(issues) {
        const list = document.getElementById("dfmIssues");
        if (list) {
            list.innerHTML = "";
        }
        issues
            .sort((a, b) => a.severity.localeCompare(b.severity))
            .forEach((iss) => {
                const ann = this.annotations.createAnnotation({
                    id: iss.id,
                    worldPos: iss.worldPos,
                    text: iss.message,
                });
                if (list) {
                    const li = document.createElement("li");
                    li.textContent = `${iss.severity} - ${iss.type}`;
                    li.onclick = () => {
                        this.viewer.scene.setObjectsVisible(this.viewer.scene.visibleObjects, false);
                        this.viewer.scene.setObjectVisible(ann.entity.id, true);
                        this.viewer.cameraFlight.flyTo({ aabb: iss.aabb });
                    };
                    list.appendChild(li);
                }
            });
    }

    // --- snapshot -----------------------------------------------------------
    snapshot() {
        return this.viewer.getSnapshot({ format: "png" });
    }

    // --- progression --------------------------------------------------------
    _setProgress(ratio) {
        const bar = document.getElementById("progressBar");
        if (bar) {
            bar.style.width = `${Math.round(ratio * 100)}%`;
        }
    }
}

// ==== CADLYTICS: MATERIAL PROFILE BLOCK - BEGIN ====
if (typeof collectMaterialForm !== 'function') {
  window.collectMaterialForm = function collectMaterialForm() {
    const form = document.getElementById('materialForm') || document.querySelector('[data-form="material"]');
    // Lis les champs de manière défensive
    const getVal = sel => (form && form.querySelector(sel) ? form.querySelector(sel).value : null);
    const getChecks = sel => Array.from(form ? form.querySelectorAll(sel) : []).filter(i => i.checked).map(i => i.value);
    return {
      family: getVal('[name="materialFamily"]'),
      rigidity: getVal('[name="rigidity"]'),
      color: getVal('[name="color"]'),
      constraints: getChecks('[name="constraints"]'),
    };
  };
}
(function ensureMaterialConfirmHandler(){
  const btn = document.getElementById('materialModalConfirm') || document.querySelector('[data-action="material-confirm"]');
  if (!btn || btn.dataset.cadlyticsBound === '1') return;
  btn.addEventListener('click', () => {
    window.state = window.state || {};
    window.state.materialProfile = window.collectMaterialForm();
    document.dispatchEvent(new CustomEvent('material:confirmed', { detail: window.state.materialProfile }));
  });
  btn.dataset.cadlyticsBound = '1';
})();
// ==== CADLYTICS: MATERIAL PROFILE BLOCK - END ====

// ==== CADLYTICS: DFM CHAIN BLOCK - BEGIN ====
(function bindDFMAfterMaterial(){
  if (window.__cadlyticsDFMChained) return;
  window.__cadlyticsDFMChained = true;
  document.addEventListener('material:confirmed', () => {
    window.state = window.state || {};
    if (window.state.fileLoaded && window.state.materialProfile) {
      if (typeof window.runDFM === 'function') {
        window.runDFM();
      } else {
        console.warn('runDFM() introuvable. Vérifie son export global.');
      }
    } else {
      console.warn('DFM non lancée (pré-requis manquants):', {
        fileLoaded: window.state.fileLoaded,
        materialProfile: !!window.state.materialProfile
      });
    }
  });
})();
// ==== CADLYTICS: DFM CHAIN BLOCK - END ====

// ==== CADLYTICS: TOAST UTIL - BEGIN ====
(function ensureToast(){
  if (window.showToast) return;
  const ensureStyle = () => {
    if (document.getElementById('cadlytics-toast-style')) return;
    const css = document.createElement('style');
    css.id = 'cadlytics-toast-style';
    css.textContent = `
    .cadlytics-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);padding:12px 16px;border-radius:8px;background:#333;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.2);opacity:.96;z-index:9999;font:14px/1.3 system-ui,Segoe UI,Roboto}
    `;
    document.head.appendChild(css);
  };
  window.showToast = function(message){
    ensureStyle();
    const el = document.createElement('div');
    el.className = 'cadlytics-toast';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(()=>{ el.remove(); }, 3000);
  };
})();
// ==== CADLYTICS: TOAST UTIL - END ====
