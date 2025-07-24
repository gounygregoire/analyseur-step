class XeokitViewerApp {
    constructor() {
        if (!this._isWebGL2()) {
            console.warn('WebGL2 non disponible, chargement du viewer Three.js en secours');
            const fallbackScript = document.createElement('script');
            fallbackScript.src = '/static/js/viewer.js';
            document.body.appendChild(fallbackScript);
            return;
        }

        this.viewer = new xeokit.Viewer({
            canvasId: 'viewer3d',
            transparent: true
        });

        this._section = new xeokit.SectionPlanesPlugin(this.viewer);
        this._measure = new xeokit.MeasurementsPlugin(this.viewer);
        this._annotations = new xeokit.AnnotationPlugin(this.viewer);

        this._bindUI();
    }

    _isWebGL2() {
        const canvas = document.createElement('canvas');
        return !!(window.WebGL2RenderingContext && canvas.getContext('webgl2'));
    }

    loadModel(url) {
        const loader = new xeokit.XKTLoaderPlugin(this.viewer);
        loader.load({ src: url, edges: true });
    }

    toggleWireframe() {
        const state = !this._wireframe;
        this._wireframe = state;
        const objects = this.viewer.scene.objects;
        for (const id in objects) {
            objects[id].wireframe = state;
        }
    }

    enableSection(axis) {
        this._section.removeSectionPlanes();
        const dir = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1];
        this._section.createSectionPlane({ id: 'cut', dir, pos: [0, 0, 0] });
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

    _bindUI() {
        document.getElementById('toggleWireframeBtn')?.addEventListener('click', () => this.toggleWireframe());
        document.getElementById('crossSectionBtn')?.addEventListener('click', () => this.enableSection('z'));
        document.getElementById('measureBtn')?.addEventListener('click', () => this.toggleMeasurements());
        document.getElementById('generatePdfBtn')?.addEventListener('click', () => this.exportPDF());
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.xeokitApp = new XeokitViewerApp();
});
