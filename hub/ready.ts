// Tells the service manager that runs hex as Type=notify that it serves, through systemd-notify since Bun has no unix datagram socket: https://www.freedesktop.org/software/systemd/man/latest/sd_notify.html
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
