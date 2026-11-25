# Isolated official host for the bridge socket gateway (plan task 29).
#
# The official artifact is installed exactly as a user would install it, into an image of its own: the
# user's OmO installation is never touched, and the container gets its own HOME, state and credentials
# directory. Nothing secret is baked in — the model key is injected at run time by the caller.
FROM node:22-bookworm-slim

ARG OMO_VERSION=5.1.75

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git unzip procps \
 && rm -rf /var/lib/apt/lists/*

# The official npm artifact, pinned: the version is what the acceptance record names.
RUN npm install -g --no-fund --no-audit omo-ai@${OMO_VERSION} \
 && omo --version

RUN useradd --create-home --uid 10001 --shell /bin/bash bridge \
 && chown -R bridge:bridge /usr/local/lib/node_modules \
 && chown root:root /usr/local/bin/omo \
 && mkdir -p /work /run/bridge \
 && chown -R bridge:bridge /work /run/bridge

# The byte-transparent relay each gateway connection runs inside this container.
COPY --chown=root:root relay.mjs /opt/bridge-relay.mjs

USER bridge
ENV HOME=/home/bridge
WORKDIR /work
CMD ["sleep", "infinity"]
