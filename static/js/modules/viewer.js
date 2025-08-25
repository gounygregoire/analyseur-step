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
