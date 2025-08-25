function initXeokit(stlUrl) {
    if (typeof Viewer !== 'function') {
        console.error('xeokit SDK manquant');
        return null;
    }

    const viewer = new Viewer({
        canvasId: 'myCanvas'
    });

    const loader = new STLLoaderPlugin(viewer);

    const section = new SectionPlanesPlugin(viewer, {
        overviewCanvasId: 'myOverviewCanvas'
    });

    const distancePlugin = new DistanceMeasurementsPlugin(viewer);
    const distanceControl = new DistanceMeasurementsMouseControl(viewer, {
        measurements: distancePlugin
    });

    const annotations = new AnnotationsPlugin(viewer, {});

    loader.load({
        src: stlUrl,
        edges: true,
        success: () => {
            const aabb = viewer.scene.getAABB();
            viewer.cameraFlight.flyTo({ aabb });

            const center = [
                (aabb[0] + aabb[3]) / 2,
                (aabb[1] + aabb[4]) / 2,
                (aabb[2] + aabb[5]) / 2
            ];

            annotations.createAnnotation({
                id: 'demo',
                worldPos: center,
                text: 'Annotation de démonstration'
            });
        }
    });

    return viewer;
}

document.addEventListener('DOMContentLoaded', () => {
    const stlUrl = document.body.dataset.modelUrl;
    if (stlUrl) {
        window.viewer = initXeokit(stlUrl);
    }
});
