class XeokitViewerApp {
    constructor() {
        if (typeof window.xeokit === 'undefined') {
            console.error('xeokit SDK non chargé, le viewer ne peut pas démarrer.');
            return;
        }
        if (!this._isWebGL2()) {
            console.warn('WebGL2 non disponible, le viewer ne peut pas démarrer.');
            return;
        }

        this.viewer = new xeokit.Viewer({
            canvasId: 'viewer3d',
            transparent: true
        });

        this._section = new xeokit.SectionPlanesPlugin(this.viewer);
        this._measure = new xeokit.MeasurementsPlugin(this.viewer);
        this._annotations = new xeokit.AnnotationPlugin(this.viewer);

        this._initialCamera = {
            eye: this.viewer.camera.eye.slice(),
            look: this.viewer.camera.look.slice(),
            up: this.viewer.camera.up.slice()
        };

        this._bindUI();
    }

    _isWebGL2() {
        const canvas = document.createElement('canvas');
        return !!(window.WebGL2RenderingContext && canvas.getContext('webgl2'));
    }

    loadModel(url) {
        const loader = new xeokit.XKTLoaderPlugin(this.viewer);
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

    exportPDF() {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        const img = this.viewer.canvas.toDataURL('image/png');
        doc.text('Rapport DFM', 10, 10);
        doc.addImage(img, 'PNG', 10, 20, 180, 120);
        fetch('/api/dfm-summary').then(r => r.json()).then(data => {
            doc.text(data.summary || '', 10, 150);
            doc.save('rapport.pdf');
        });
    }

    resetView() {
        if (this._initialCamera) {
            this.viewer.cameraFlight.flyTo(this._initialCamera);
        }
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

document.addEventListener('DOMContentLoaded', () => {
    window.xeokitApp = new XeokitViewerApp();
});
