# A stand-in for a bare server: SSH in, Docker inside, nothing else.
#
# This is not a model of a production host. It has no firewall, no fail2ban, no unattended
# upgrades, and the deploy user logs in with a key that lives in this repository's working tree. Its
# only job is to be something Kamal can deploy to over SSH so the deploy pipeline can be
# built and broken on purpose without paying for a VPS.
FROM docker:28-dind

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
RUN ssh-keygen -A \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && (addgroup -S docker 2>/dev/null || true) \
 && adduser -D -s /bin/bash deploy \
 && addgroup deploy docker \
 && sed -i 's/^deploy:!/deploy:*/' /etc/shadow \
 && mkdir -p /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && chown deploy:deploy /home/deploy/.ssh

# Where every deploy stores its verified pre-deploy dump, as server/bootstrap.sh creates it.
RUN mkdir -p /var/backups/shipkit && chown deploy:deploy /var/backups/shipkit && chmod 700 /var/backups/shipkit

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
