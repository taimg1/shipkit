# A stand-in for a bare server: SSH in, Docker inside, nothing else.
#
# This is not a model of a production host. It has no firewall, no fail2ban, no unattended
# upgrades, and root logs in with a key that lives in this repository's working tree. Its
# only job is to be something Kamal can deploy to over SSH so the deploy pipeline can be
# built and broken on purpose without paying for a VPS.
FROM docker:28-dind

RUN apk add --no-cache openssh bash curl postgresql17-client

# Host keys for sshd, and key-only root login — there is no password to guess because there
# is no password.
RUN ssh-keygen -A \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && mkdir -p /root/.ssh && chmod 700 /root/.ssh

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
