// Tells the service manager that runs hex as Type=notify that it serves, through systemd-notify since Bun has no unix datagram socket: https://www.freedesktop.org/software/systemd/man/latest/sd_notify.html
export function ready() {
  const notify = Bun.which("systemd-notify");

  if ((process.env.NOTIFY_SOCKET ?? "") !== "" && notify !== null) {
    Bun.spawn([notify, "--ready"]);
  }
}
