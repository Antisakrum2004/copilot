#!/bin/bash
set -e
cd /home/z/my-project

# Install dependencies
bun install 2>/dev/null || true

# Setup database
bun run db:push 2>/dev/null || true

# Build the project for production
bun run build 2>/dev/null || true

# Create IPv6 proxy so Caddy can reach Next.js
cat > /tmp/ipv6_proxy.js << 'PROXY'
const net = require('net');
const proxy = net.createServer((clientSocket) => {
  const serverSocket = net.connect(3001, '127.0.0.1', () => {
    clientSocket.pipe(serverSocket);
    serverSocket.pipe(clientSocket);
  });
  clientSocket.on('error', () => clientSocket.destroy());
  serverSocket.on('error', () => serverSocket.destroy());
  clientSocket.on('close', () => serverSocket.destroy());
  serverSocket.on('close', () => clientSocket.destroy());
});
proxy.listen(3000, '::1', () => {
  console.log('IPv6 proxy: [::1]:3000 -> 127.0.0.1:3001');
});
PROXY

# Start IPv6 proxy in background
node /tmp/ipv6_proxy.js &
sleep 1

# Start Next.js production server on port 3001
HOSTNAME="0.0.0.0" PORT=3001 node .next/standalone/server.js
