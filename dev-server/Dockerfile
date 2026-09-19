# A stand-in for a bare server: SSH in, Docker inside, nothing else.
#
# This is not a model of a production host. It has no firewall, no fail2ban, no unattended
# upgrades, and the deploy user logs in with a key that lives in this repository's working tree. Its
# only job is to be something Kamal can deploy to over SSH so the deploy pipeline can be
# built and broken on purpose without paying for a VPS.
# docker:28-dind, pinned by digest.
FROM docker:28-dind@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac

RUN apk add --no-cache openssh bash curl postgresql17-client

# Logged into the way a hardened server is: as a deploy user with a key, never as root, never
# with a password. Every deploy used to run as root here, which proved nothing about the
# server a client would actually have (#15).
#
# `deploy` is in the docker group. That is root-equivalent — anyone who can run containers
# can mount the host's filesystem — and it is what Kamal requires. It is written down in
# docs/runbooks/deploy.md rather than pretended away.
#
# Alpine's `adduser -D` leaves the account locked ("!"), and sshd refuses locked accounts even
# for key logins; "*" means "no password" without "locked".
#
# The host key is fixed and committed (host-key/), not generated per build: the fixture pins it
# in shipkit.yaml as hostKey, and the pipeline refuses a server whose key it does not know. A
# simulated server whose key changed on every rebuild would teach everyone to re-pin without
# looking, which is the habit the pin exists to break. Only ed25519 is offered, so there is
# exactly one key to pin. Its private half is public knowledge — one more reason this image is
# never pointed at anything real.
COPY host-key/ssh_host_ed25519_key host-key/ssh_host_ed25519_key.pub /etc/ssh/
RUN chmod 600 /etc/ssh/ssh_host_ed25519_key && chmod 644 /etc/ssh/ssh_host_ed25519_key.pub \
 && printf '\nHostKey /etc/ssh/ssh_host_ed25519_key\n' >> /etc/ssh/sshd_config \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && (addgroup -S docker 2>/dev/null || true) \
 && adduser -D -s /bin/bash deploy \
 && addgroup deploy docker \
 && sed -i 's/^deploy:!/deploy:*/' /etc/shadow \
 && mkdir -p /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && chown deploy:deploy /home/deploy/.ssh

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
