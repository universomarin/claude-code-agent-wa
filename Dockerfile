FROM node:20-slim

# Install system deps: SSH server, Claude Code CLI, ffmpeg, Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    ffmpeg \
    chromium \
    fonts-liberation \
    ca-certificates \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code

# Configure SSH
RUN mkdir /var/run/sshd \
    && echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config \
    && echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config

# App setup
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# Create persistent directories
RUN mkdir -p auth_info history audio_tmp files logs /root/.claude

# Chromium path for Linux
ENV CHROME_PATH=/usr/bin/chromium
ENV NODE_ENV=production

# Expose SSH port
EXPOSE 22

# Startup script: SSH + bot
COPY start.sh /start.sh
RUN chmod +x /start.sh

CMD ["/start.sh"]
