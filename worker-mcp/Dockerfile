FROM docker.io/cloudflare/sandbox:0.5.6

RUN apt-get update && apt-get install -y \
    vim \
    jq \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
