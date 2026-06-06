self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
      if (cs.length > 0) return cs[0].focus();
      return clients.openWindow('/');
    })
  );
});
