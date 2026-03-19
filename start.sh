#!/bin/bash

# Set root password from env var (set SSH_PASSWORD in Railway)
if [ -n "$SSH_PASSWORD" ]; then
  echo "root:$SSH_PASSWORD" | chpasswd
  echo "✅ SSH password configured"
else
  echo "⚠️  No SSH_PASSWORD set — SSH login disabled"
fi

# Generate SSH host keys if missing (first deploy or fresh container)
ssh-keygen -A

# Start SSH server in background
/usr/sbin/sshd -D &
echo "✅ SSH server running on port 22"

# Start the WhatsApp bot
echo "🚀 Starting WhatsApp bot..."
exec node /app/index.js
