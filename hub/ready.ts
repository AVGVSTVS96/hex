// WARNING: Bun has no unix datagram socket, so readiness goes through systemd-notify: https://www.freedesktop.org/software/systemd/man/latest/sd_notify.html
export function ready() {
  if ((process.env.NOTIFY_SOCKET ?? "") === "") {
    return;
  }

  try {
    Bun.spawn(["systemd-notify", "--ready"]);
  } catch (error) {
    process.stderr.write(`hub: couldn't tell systemd that hex serves: ${String(error)}\n`);
  }
}
