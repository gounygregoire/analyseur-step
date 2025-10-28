FROM python:3.11-slim

# OS deps nécessaires pour NodeSource et npx
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl gnupg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Node 20 + npm/npx
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && node -v && npm -v && npx -v

# Dépendances Python du worker
COPY requirements-worker.txt /tmp/requirements-worker.txt
RUN pip install --no-cache-dir -r /tmp/requirements-worker.txt

# Vérification de l'accès à xeokit-gltf-to-xkt via npx
RUN npx --yes xeokit-gltf-to-xkt --help || true

WORKDIR /app
COPY . /app

# Démarre un worker RQ (serializer par défaut, sans doublon)
CMD ["rq", "worker", "-u", "$REDIS_URL", "-P", "/opt/render/project/src", "${RQ_QUEUE_NAME:-default}"]
