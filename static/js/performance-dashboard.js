/**
 * Performance Dashboard Controller for CADlytitcs
 * Manages the performance monitoring interface and real-time updates
 */

class PerformanceDashboard {
    constructor() {
        this.isActive = false;
        this.updateInterval = null;
        this.charts = {};
        this.performanceLog = [];
        
        this.initializeCharts();
        this.setupEventListeners();
        this.startDashboard();
    }

    initializeCharts() {
        // FPS Chart
        const fpsCtx = document.getElementById('fpsChart').getContext('2d');
        this.charts.fps = new Chart(fpsCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'FPS',
                    data: [],
                    borderColor: 'rgba(138, 123, 100, 1)',
                    backgroundColor: 'rgba(138, 123, 100, 0.1)',
                    tension: 0.4,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        max: 60,
                        grid: {
                            color: 'rgba(138, 123, 100, 0.2)'
                        }
                    },
                    x: {
                        grid: {
                            color: 'rgba(138, 123, 100, 0.2)'
                        }
                    }
                },
                plugins: {
                    legend: {
                        labels: {
                            color: 'rgba(91, 82, 71, 1)'
                        }
                    }
                }
            }
        });

        // Memory Chart
        const memoryCtx = document.getElementById('memoryChart').getContext('2d');
        this.charts.memory = new Chart(memoryCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Mémoire utilisée (MB)',
                    data: [],
                    borderColor: 'rgba(91, 82, 71, 1)',
                    backgroundColor: 'rgba(91, 82, 71, 0.1)',
                    tension: 0.4,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: {
                            color: 'rgba(138, 123, 100, 0.2)'
                        }
                    },
                    x: {
                        grid: {
                            color: 'rgba(138, 123, 100, 0.2)'
                        }
                    }
                },
                plugins: {
                    legend: {
                        labels: {
                            color: 'rgba(91, 82, 71, 1)'
                        }
                    }
                }
            }
        });
    }

    setupEventListeners() {
        // Control buttons
        document.getElementById('startMonitoringBtn').addEventListener('click', () => this.startMonitoring());
        document.getElementById('pauseMonitoringBtn').addEventListener('click', () => this.pauseMonitoring());
        document.getElementById('clearMetricsBtn').addEventListener('click', () => this.clearMetrics());
        document.getElementById('exportMetricsBtn').addEventListener('click', () => this.exportMetrics());
    }

    startDashboard() {
        this.isActive = true;
        this.updateInterval = setInterval(() => this.updateDashboard(), 1000);
        this.updateUI();
    }

    startMonitoring() {
        if (window.performanceMonitor) {
            window.performanceMonitor.startMonitoring();
            this.logEvent('Surveillance démarrée', 'info');
        }
        this.updateUI();
    }

    pauseMonitoring() {
        if (window.performanceMonitor) {
            window.performanceMonitor.stopMonitoring();
            this.logEvent('Surveillance interrompue', 'warning');
        }
        this.updateUI();
    }

    clearMetrics() {
        if (window.performanceMonitor) {
            window.performanceMonitor.clearMetrics();
            this.clearCharts();
            this.clearPerformanceLog();
            this.logEvent('Métriques effacées', 'info');
        }
        this.updateUI();
    }

    exportMetrics() {
        if (window.performanceMonitor) {
            const metrics = window.performanceMonitor.exportMetrics();
            const dataStr = JSON.stringify(metrics, null, 2);
            const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
            
            const exportFileDefaultName = `cadlytics-performance-${new Date().toISOString().slice(0,19)}.json`;
            
            const linkElement = document.createElement('a');
            linkElement.setAttribute('href', dataUri);
            linkElement.setAttribute('download', exportFileDefaultName);
            linkElement.click();
            
            this.logEvent('Métriques exportées', 'success');
        }
    }

    updateDashboard() {
        if (!this.isActive || !window.performanceMonitor) return;

        const stats = window.performanceMonitor.getStats();
        this.updateMetricCards(stats);
        this.updateCharts(stats);
        this.updateDetailedStats(stats);
    }

    updateMetricCards(stats) {
        // FPS
        const fpsValue = stats.frameRate ? Math.round(stats.frameRate.current) : '--';
        document.getElementById('avgFpsValue').textContent = fpsValue;

        // Memory
        const memoryValue = stats.memoryUsage ? stats.memoryUsage.used : '--';
        document.getElementById('memoryUsageValue').textContent = memoryValue;

        // Rendering time
        const renderTime = stats.rendering ? Math.round(stats.rendering.avg) : '--';
        document.getElementById('renderTimeValue').textContent = renderTime;

        // Conversion time
        const conversionTime = stats.conversion ? Math.round(stats.conversion.avg / 1000) : '--';
        document.getElementById('conversionTimeValue').textContent = conversionTime;
    }

    updateCharts(stats) {
        const now = new Date().toLocaleTimeString();

        // Update FPS chart
        if (stats.frameRate) {
            this.updateChart(this.charts.fps, now, Math.round(stats.frameRate.current));
        }

        // Update Memory chart
        if (stats.memoryUsage) {
            this.updateChart(this.charts.memory, now, parseFloat(stats.memoryUsage.used));
        }
    }

    updateChart(chart, label, value) {
        chart.data.labels.push(label);
        chart.data.datasets[0].data.push(value);

        // Keep only last 20 data points
        if (chart.data.labels.length > 20) {
            chart.data.labels.shift();
            chart.data.datasets[0].data.shift();
        }

        chart.update('none');
    }

    updateDetailedStats(stats) {
        // Rendering stats
        if (stats.rendering) {
            document.getElementById('renderAvg').textContent = Math.round(stats.rendering.avg) + ' ms';
            document.getElementById('renderMedian').textContent = Math.round(stats.rendering.median) + ' ms';
            document.getElementById('renderP95').textContent = Math.round(stats.rendering.p95) + ' ms';
        }

        // Conversion stats
        if (stats.conversion) {
            document.getElementById('conversionCount').textContent = stats.conversion.count;
            document.getElementById('conversionAvg').textContent = Math.round(stats.conversion.avg / 1000) + ' s';
            document.getElementById('conversionMax').textContent = Math.round(stats.conversion.max / 1000) + ' s';
        }

        // DFM stats
        if (stats.dfmAnalysis) {
            document.getElementById('dfmCount').textContent = stats.dfmAnalysis.count;
            document.getElementById('dfmAvg').textContent = Math.round(stats.dfmAnalysis.avg / 1000) + ' s';
            document.getElementById('dfmMax').textContent = Math.round(stats.dfmAnalysis.max / 1000) + ' s';
        }
    }

    clearCharts() {
        Object.values(this.charts).forEach(chart => {
            chart.data.labels = [];
            chart.data.datasets[0].data = [];
            chart.update();
        });
    }

    clearPerformanceLog() {
        this.performanceLog = [];
        const tbody = document.getElementById('performanceLogBody');
        tbody.innerHTML = `
            <tr>
                <td colspan="4" class="text-center text-muted">
                    Aucun événement de performance enregistré
                </td>
            </tr>
        `;
    }

    logEvent(operation, type = 'info', duration = null) {
        const event = {
            timestamp: new Date(),
            operation: operation,
            type: type,
            duration: duration
        };

        this.performanceLog.unshift(event);
        
        // Keep only last 50 events
        if (this.performanceLog.length > 50) {
            this.performanceLog = this.performanceLog.slice(0, 50);
        }

        this.updatePerformanceLog();
    }

    updatePerformanceLog() {
        const tbody = document.getElementById('performanceLogBody');
        
        if (this.performanceLog.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="4" class="text-center text-muted">
                        Aucun événement de performance enregistré
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = this.performanceLog.map(event => {
            const statusClass = this.getStatusClass(event.type);
            const durationText = event.duration ? `${Math.round(event.duration)}ms` : '--';
            
            return `
                <tr>
                    <td>${event.timestamp.toLocaleTimeString()}</td>
                    <td>${event.operation}</td>
                    <td>${durationText}</td>
                    <td><span class="badge ${statusClass}">${this.getStatusText(event.type)}</span></td>
                </tr>
            `;
        }).join('');
    }

    getStatusClass(type) {
        switch (type) {
            case 'success': return 'bg-success';
            case 'warning': return 'bg-warning';
            case 'error': return 'bg-danger';
            case 'info':
            default: return 'bg-info';
        }
    }

    getStatusText(type) {
        switch (type) {
            case 'success': return 'Succès';
            case 'warning': return 'Attention';
            case 'error': return 'Erreur';
            case 'info':
            default: return 'Info';
        }
    }

    updateUI() {
        const isMonitoring = window.performanceMonitor && window.performanceMonitor.isRecording;
        
        document.getElementById('startMonitoringBtn').disabled = isMonitoring;
        document.getElementById('pauseMonitoringBtn').disabled = !isMonitoring;
    }

    destroy() {
        this.isActive = false;
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
        
        Object.values(this.charts).forEach(chart => {
            chart.destroy();
        });
    }
}

// Initialize dashboard when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    window.performanceDashboard = new PerformanceDashboard();
    
    // Integration with performance monitor for logging
    if (window.performanceMonitor) {
        const originalRecordMetric = window.performanceMonitor.recordMetric;
        window.performanceMonitor.recordMetric = function(type, duration, metadata) {
            originalRecordMetric.call(this, type, duration, metadata);
            
            // Log to dashboard
            if (window.performanceDashboard) {
                let operation = type;
                switch (type) {
                    case 'rendering': operation = 'Rendu 3D'; break;
                    case 'file-upload': operation = 'Upload fichier'; break;
                    case 'conversion': operation = 'Conversion STEP→STL'; break;
                    case 'dfm-analysis': operation = 'Analyse DFM'; break;
                    case 'user-interaction': operation = 'Interaction utilisateur'; break;
                }
                
                const eventType = duration > 5000 ? 'warning' : 'success';
                window.performanceDashboard.logEvent(operation, eventType, duration);
            }
        };
    }
});

// Cleanup on page unload
window.addEventListener('beforeunload', function() {
    if (window.performanceDashboard) {
        window.performanceDashboard.destroy();
    }
});