self.addEventListener('push', function (event) {
    const data = event.data.json();
    self.registration.showNotification(data.title, {
        body: data.body,
        icon: 'https://ka1se1.github.io/loveeeee/icon.png',
    });
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    event.waitUntil(
        clients.openWindow('https://ka1se1.github.io/loveeeee/')
    );
});