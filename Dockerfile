FROM python:3.11-slim

# OS deps
RUN apt-get update && apt-get install -y build-essential curl git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Node LTS + npm/npx
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
 && apt-get install -y nodejs \
 && node -v && npm -v && npx -v

# Python deps (ou via ton requirements.txt)
# Astuce: si tu as déjà un requirements.txt lourd, COPY + pip install ce fichier.
RUN pip install --no-cache-dir cadquery trimesh pygltflib numpy shapely redis rq

# Outil XKT
RUN npm install -g xeokit-gltf-to-xkt && xeokit-gltf-to-xkt --help || true

WORKDIR /app
COPY . /app

# Démarre un worker RQ
CMD ["python", "-m", "worker"]
