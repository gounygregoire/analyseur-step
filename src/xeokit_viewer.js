import { Viewer, XKTLoaderPlugin, SectionPlanesPlugin, DistanceMeasurementsPlugin, AnnotationsPlugin } from "@xeokit/xeokit-sdk";

class XeokitViewerApp {
    constructor() {

        if (!this._isWebGL2()) {
            console.warn('WebGL2 non disponible, le viewer ne peut pas démarrer.');
            if (typeof window.showError === 'function') {
                window.showError('Visualiseur indisponible : WebGL2 non disponible.');
            }
            return;
        }

        this.viewer = new Viewer({
            canvas: document.getElementById("viewer3d"),
            transparent: true
        });

        this._section = new SectionPlanesPlugin(this.viewer);
        this._measure = new DistanceMeasurementsPlugin(this.viewer);
        this._annotations = new AnnotationsPlugin(this.viewer, {});

        this._initialCamera = {
            eye: this.viewer.camera.eye.slice(),
            look: this.viewer.camera.look.slice(),
            up: this.viewer.camera.up.slice()
        };

        this._bindUI();
        this._initPicking();
    }

    _isWebGL2() {
        const canvas = document.createElement('canvas');
        return !!(window.WebGL2RenderingContext && canvas.getContext('webgl2'));
    }

    loadModel(url) {
        const loader = new XKTLoaderPlugin(this.viewer);
        loader.load({
            src: url,
            edges: true,
            success: () => {
                const aabb = this.viewer.scene.getAABB();
                this.viewer.cameraFlight.flyTo({ aabb });
                this._initialCamera = {
                    eye: this.viewer.camera.eye.slice(),
                    look: this.viewer.camera.look.slice(),
                    up: this.viewer.camera.up.slice()
                };
            }
        });
    }

    toggleWireframe() {
        const state = !this._wireframe;
        this._wireframe = state;
        const objects = this.viewer.scene.objects;
        for (const id in objects) {
            objects[id].wireframe = state;
        }
    }

    toggleEdges() {
        const state = !this._edgesVisible;
        this._edgesVisible = state;
        const objects = this.viewer.scene.objects;
        for (const id in objects) {
            objects[id].edges = state;
        }
    }

    enableSection(axis) {
        this._section.removeSectionPlanes();
        const dir = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1];
        this._section.createSectionPlane({ id: 'cut', dir, pos: [0, 0, 0] });
        this._currentSection = axis;
    }

    disableSection() {
        this._section.removeSectionPlanes();
        this._currentSection = null;
    }

    toggleSection(axis = 'z') {
        if (this._currentSection) {
            this.disableSection();
        } else {
            this.enableSection(axis);
        }
    }

    toggleMeasurements() {
        this._measure.active = !this._measure.active;
    }

    applyHeatmap(data) {
        for (const [id, color] of Object.entries(data)) {
            const obj = this.viewer.scene.objects[id];
            if (obj) obj.colorize = color;
        }
    }

    clearHeatmap() {
        const objects = this.viewer.scene.objects;
        for (const id in objects) {
            objects[id].colorize = null;
        }
    }

    captureScreenshot() {
        return this.viewer.canvas.toDataURL('image/png');
    }

    exportPDF() {
        const screenshot = this.captureScreenshot();
        const convId = window.currentConversionId || '';
        fetch(`/api/generate-pdf/${convId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ screenshot })
        })
        .then(r => r.json())
        .then(data => {
            if (data.success && data.pdf_filename) {
                window.location.href = `/download-pdf/${data.pdf_filename}`;
            } else {
                console.error('Erreur génération PDF', data);
            }
        })
        .catch(err => console.error('PDF request failed', err));
    }

    resetView() {
        if (this._initialCamera) {
            this.viewer.cameraFlight.flyTo(this._initialCamera);
        }
    }

    _initPicking() {
        this._selectedEntity = null;
        this._selectedColor = null;

        this._tooltip = document.createElement('div');
        this._tooltip.id = 'entityTooltip';
        this._tooltip.style.position = 'absolute';
        this._tooltip.style.pointerEvents = 'none';
        this._tooltip.style.display = 'none';
        document.body.appendChild(this._tooltip);

        const canvas = this.viewer.canvas;
        canvas.addEventListener('mousemove', (e) => this._handleHover(e));
        canvas.addEventListener('click', (e) => this._handleSelect(e));
    }

    _handleHover(e) {
        const hit = this.viewer.scene.pick({ canvasPos: [e.offsetX, e.offsetY] });
        if (hit && hit.entity) {
            const entity = hit.entity;
            const label = entity.name || entity.id;
            this._tooltip.textContent = label;
            this._tooltip.style.left = `${e.clientX + 10}px`;
            this._tooltip.style.top = `${e.clientY + 10}px`;
            this._tooltip.style.display = 'block';
        } else {
            this._tooltip.style.display = 'none';
        }
    }

    _handleSelect(e) {
        const hit = this.viewer.scene.pick({ canvasPos: [e.offsetX, e.offsetY] });
        if (hit && hit.entity) {
            this._highlightEntity(hit.entity);
        }
    }

    _highlightEntity(entity) {
        if (this._selectedEntity && this._selectedEntity.id !== entity.id) {
            if (this._selectedColor) {
                this._selectedEntity.colorize = this._selectedColor;
            } else {
                this._selectedEntity.colorize = null;
            }
        }

        this._selectedColor = entity.colorize ? entity.colorize.slice() : null;
        entity.colorize = [1, 0.8, 0];
        this._selectedEntity = entity;
    }

    _bindUI() {
        document.getElementById('resetViewBtn')?.addEventListener('click', () => this.resetView());
        document.getElementById('toggleWireframeBtn')?.addEventListener('click', () => this.toggleWireframe());
        document.getElementById('toggleEdgesBtn')?.addEventListener('click', () => this.toggleEdges());
        document.getElementById('crossSectionBtn')?.addEventListener('click', () => {
            const axis = document.getElementById('crossSectionAxisSelect')?.value || 'z';
            this.toggleSection(axis);
        });
        document.getElementById('crossSectionAxisSelect')?.addEventListener('change', (e) => {
            if (this._currentSection) this.enableSection(e.target.value);
        });
        document.getElementById('measureBtn')?.addEventListener('click', () => this.toggleMeasurements());
        document.getElementById('generatePdfBtn')?.addEventListener('click', () => this.exportPDF());
    }
}

function loadXeokitSDK(callback) {
    // Le SDK est déjà inclus via le bundle
    if (typeof callback === 'function') {
        callback();
    }
}

function initViewer() {
    window.xeokitApp = new XeokitViewerApp();
    window.viewer = window.xeokitApp;
}


export { XeokitViewerApp, loadXeokitSDK, initViewer };
