/**
 * Performance Monitor for CADlytitcs
 * Tracks rendering times, file processing, and user interactions
 */

class PerformanceMonitor {
    constructor() {
        this.metrics = {
            renderingTimes: [],
            fileUploadTimes: [],
            conversionTimes: [],
            dfmAnalysisTimes: [],
            userInteractions: [],
            memoryUsage: [],
            frameRates: []
        };
        
        this.isRecording = false;
        this.startTime = null;
        this.frameCount = 0;
        this.lastFrameTime = performance.now();
        
        // Initialize performance observers
        this.initPerformanceObservers();
        
        // Start monitoring
        this.startMonitoring();
    }

    initPerformanceObservers() {
        // Monitor resource loading times
        if ('PerformanceObserver' in window) {
            const observer = new PerformanceObserver((list) => {
                list.getEntries().forEach((entry) => {
                    if (entry.entryType === 'measure') {
                        this.recordMetric(entry.name, entry.duration);
                    }
                });
            });
            
            observer.observe({ entryTypes: ['measure', 'navigation'] });
        }
    }

    startMonitoring() {
        this.isRecording = true;
        this.monitorFrameRate();
        this.monitorMemoryUsage();
    }

    stopMonitoring() {
        this.isRecording = false;
    }

    // Record different types of metrics
    recordMetric(type, duration, metadata = {}) {
        const metric = {
            timestamp: Date.now(),
            duration: duration,
            metadata: metadata
        };

        switch (type) {
            case 'rendering':
                this.metrics.renderingTimes.push(metric);
                break;
            case 'file-upload':
                this.metrics.fileUploadTimes.push(metric);
                break;
            case 'conversion':
                this.metrics.conversionTimes.push(metric);
                break;
            case 'dfm-analysis':
                this.metrics.dfmAnalysisTimes.push(metric);
                break;
            case 'user-interaction':
                this.metrics.userInteractions.push(metric);
                break;
        }

        // Keep only last 100 entries per metric
        Object.keys(this.metrics).forEach(key => {
            if (this.metrics[key].length > 100) {
                this.metrics[key] = this.metrics[key].slice(-100);
            }
        });
    }

    // Monitor frame rate for 3D rendering
    monitorFrameRate() {
        if (!this.isRecording) return;

        const now = performance.now();
        const delta = now - this.lastFrameTime;
        this.lastFrameTime = now;
        
        if (delta > 0) {
            const fps = 1000 / delta;
            this.metrics.frameRates.push({
                timestamp: Date.now(),
                fps: fps
            });
        }

        this.frameCount++;
        requestAnimationFrame(() => this.monitorFrameRate());
    }

    // Monitor memory usage
    monitorMemoryUsage() {
        if (!this.isRecording) return;

        if ('memory' in performance) {
            const memInfo = performance.memory;
            this.metrics.memoryUsage.push({
                timestamp: Date.now(),
                usedJSHeapSize: memInfo.usedJSHeapSize,
                totalJSHeapSize: memInfo.totalJSHeapSize,
                jsHeapSizeLimit: memInfo.jsHeapSizeLimit
            });
        }

        setTimeout(() => this.monitorMemoryUsage(), 5000); // Every 5 seconds
    }

    // Mark performance points
    markStart(operation) {
        performance.mark(`${operation}-start`);
        return Date.now();
    }

    markEnd(operation, startTime) {
        const endTime = Date.now();
        const duration = endTime - startTime;
        performance.mark(`${operation}-end`);
        performance.measure(operation, `${operation}-start`, `${operation}-end`);
        return duration;
    }

    // Get performance statistics
    getStats() {
        return {
            rendering: this.calculateStats(this.metrics.renderingTimes),
            fileUpload: this.calculateStats(this.metrics.fileUploadTimes),
            conversion: this.calculateStats(this.metrics.conversionTimes),
            dfmAnalysis: this.calculateStats(this.metrics.dfmAnalysisTimes),
            frameRate: this.calculateFrameRateStats(),
            memoryUsage: this.getLatestMemoryUsage(),
            userInteractions: this.metrics.userInteractions.length
        };
    }

    calculateStats(metrics) {
        if (metrics.length === 0) return null;

        const durations = metrics.map(m => m.duration);
        const sorted = durations.sort((a, b) => a - b);
        
        return {
            count: metrics.length,
            avg: durations.reduce((a, b) => a + b, 0) / durations.length,
            min: Math.min(...durations),
            max: Math.max(...durations),
            median: sorted[Math.floor(sorted.length / 2)],
            p95: sorted[Math.floor(sorted.length * 0.95)],
            recent: metrics.slice(-10).map(m => m.duration)
        };
    }

    calculateFrameRateStats() {
        if (this.metrics.frameRates.length === 0) return null;

        const recentFrames = this.metrics.frameRates.slice(-60); // Last 60 frames
        const fps = recentFrames.map(f => f.fps);
        
        return {
            current: fps[fps.length - 1] || 0,
            avg: fps.reduce((a, b) => a + b, 0) / fps.length,
            min: Math.min(...fps),
            max: Math.max(...fps)
        };
    }

    getLatestMemoryUsage() {
        if (this.metrics.memoryUsage.length === 0) return null;
        
        const latest = this.metrics.memoryUsage[this.metrics.memoryUsage.length - 1];
        return {
            used: (latest.usedJSHeapSize / 1024 / 1024).toFixed(2), // MB
            total: (latest.totalJSHeapSize / 1024 / 1024).toFixed(2), // MB
            limit: (latest.jsHeapSizeLimit / 1024 / 1024).toFixed(2) // MB
        };
    }

    // Export metrics for analysis
    exportMetrics() {
        return {
            timestamp: Date.now(),
            metrics: this.metrics,
            stats: this.getStats()
        };
    }

    // Clear all metrics
    clearMetrics() {
        Object.keys(this.metrics).forEach(key => {
            this.metrics[key] = [];
        });
    }
}

// Global performance monitor instance
window.performanceMonitor = new PerformanceMonitor();

// Helper functions for easy integration
window.perfStart = (operation) => window.performanceMonitor.markStart(operation);
window.perfEnd = (operation, startTime) => window.performanceMonitor.markEnd(operation, startTime);
window.perfRecord = (type, duration, metadata) => window.performanceMonitor.recordMetric(type, duration, metadata);