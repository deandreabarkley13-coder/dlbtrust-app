FROM btcpayserver/bitcoin:29.2 AS bitcoin
FROM nicolasdorier/nbxplorer:2.6.8 AS nbxplorer
FROM btcpayserver/btcpayserver:2.4.1

USER root

# Install supervisor and basic tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    supervisor ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Copy Bitcoin Core binaries
COPY --from=bitcoin /usr/local/bin/* /usr/local/bin/

# Copy NBXplorer app
COPY --from=nbxplorer /app /app/nbxplorer

# Supervisor and start script
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

# Data directories
RUN mkdir -p /data/bitcoin /data/nbxplorer /data/btcpay /var/log/supervisor

ENV BTCPAY_NETWORK=mainnet
ENV BTCPAY_CHAINS=btc
ENV BTCPAY_NODEFAULTCHAIN=true
ENV BTCPAY_BIND=0.0.0.0:23000
ENV BTCPAY_ROOTPATH=/
ENV BTCPAY_DATADIR=/data/btcpay

EXPOSE 23000 8333 8332 28332 28333

ENTRYPOINT ["/usr/local/bin/start.sh"]
