# Observabilité

## Démarrer Prometheus et Grafana

```
docker-compose up prometheus grafana
```

- Prometheus : http://localhost:9090
- Grafana : http://localhost:3000 (admin/admin)

## Prometheus

`prometheus.yml` configure la cible Flask :

```
scrape_configs:
  - job_name: cadlytics
    static_configs:
      - targets: ['web:8000']
```

## Dashboard Grafana

Importer `observability/grafana-dashboard.json`.

## Modules

- `observability/logging.py` : logs JSON corrélés par `modelId`/`sha256`.
- `observability/metrics.py` : métriques Prometheus et endpoint `/metrics`.
