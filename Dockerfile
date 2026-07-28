FROM mcr.microsoft.com/powershell:7.4-ubuntu-22.04

# --- OS deps: Node.js 20, 7zip (reads ISO9660 without loop-mounting), unzip,
# plus Python + the specific modules VMware.ImageBuilder needs under the hood ---
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg p7zip-full unzip \
      python3 python3-pip python3-six python3-lxml python3-psutil python3-openssl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# --- VMware PowerCLI (Image Builder cmdlets live here) ---
# NOTE: requires access to www.powershellgallery.com at build time.
RUN pwsh -NoLogo -NonInteractive -Command \
    "Set-PSRepository -Name PSGallery -InstallationPolicy Trusted; \
     Install-Module -Name VMware.PowerCLI -Scope AllUsers -Force -AllowClobber; \
     Set-PowerCLIConfiguration -Scope AllUsers -ParticipateInCEIP \$false -InvalidCertificateAction Ignore -PythonPath /usr/bin/python3 -Confirm:\$false"

WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install

COPY backend ./
COPY frontend /app/frontend
RUN npm run build

RUN mkdir -p /data/uploads /data/extracted-spp /data/extracted-esxi /data/output
VOLUME ["/data"]

ENV PORT=3000 \
    DATA_DIR=/data
EXPOSE 3000

CMD ["node", "dist/server.js"]
