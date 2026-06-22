FROM docker.io/cloudflare/sandbox:0.5.6

RUN apt-get update && apt-get install -y \
    vim \
    jq \
    build-essential \
    curl \
    git \
    python3 \
    python3-pip \
    python3-venv \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir \
    requests beautifulsoup4 lxml \
    pandas numpy matplotlib \
    httpx

RUN npm install -g typescript tsx

WORKDIR /workspace
