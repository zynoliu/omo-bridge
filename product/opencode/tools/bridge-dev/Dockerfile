# Bridge development/QA container definition (task 2).
# Build context is exactly this directory: no node_modules, no repository content.
FROM oven/bun@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d

USER root
RUN mkdir -p /home/bridge /opt/agent /data /sockets \
 && chown -R 10001:10001 /home/bridge /opt/agent /data /sockets
USER 10001:10001
ENV HOME=/home/bridge
WORKDIR /home/bridge
CMD ["sleep", "infinity"]
