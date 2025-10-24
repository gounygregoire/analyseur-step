FROM python:3.11-slim

# 1) OS deps
RUN apt-get update && apt-get install -y \
    build-essential curl git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 2) Node LTS + npx
ENV NODE_VERSION=18.19.1
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
 && apt-get install -y nodejs \
 && node -v && npm -v && npx -v

# 3) Python deps (CadQuery, trimesh…)
# Si ton requirements.txt existe déjà, utilise-le sinon installe a minima:
RUN pip install --no-cache-dir cadquery trimesh pygltflib numpy shapely

# 4) Outils XKT côté Node
# Deux options; installe au moins l’un des deux:
# a) xeokit-gltf-to-xkt
RUN npm install -g xeokit-gltf-to-xkt
# b) ou xeokit-convert (si tu l'utilises)
# RUN npm install -g @xeokit/xeokit-convert

# 5) Vérifs
RUN xeokit-gltf-to-xkt --help || true

# 6) App
WORKDIR /app
COPY . /app

CMD ["python", "-m", "worker"]
