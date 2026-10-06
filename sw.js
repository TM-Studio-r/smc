self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function siteIsOpen() {
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  return windows.some((client) => {
    try {
      return client.visibilityState === "visible";
    } catch {
      return false;
    }
  });
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data = { title: "New message", body: "You have a new message", url: "./" };

    try {
      if (event.data) data = { ...data, ...event.data.json() };
    } catch {
      try {
        if (event.data) data.body = event.data.text();
      } catch {}
    }

    // Never show a notification while Class gap is visibly open.
    if (await siteIsOpen()) return;

    await self.registration.showNotification(data.title, {
      body: data.body,
      icon: "./assets/icons/icon-192.svg",
      badge: "./assets/icons/icon-192.svg",
      tag: data.chatId ? `tm-${data.chatId}` : "tm-message",
      renotify: true,
      data: {
        url: data.url || "./",
        chatId: data.chatId || "",
      },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil((async () => {
    const url = new URL(
      event.notification.data?.url || "./",
      self.location.origin
    ).href;

    const windows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });

    for (const client of windows) {
      try {
        if ("navigate" in client) await client.navigate(url);
        if ("focus" in client) return client.focus();
      } catch {}
    }

    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
